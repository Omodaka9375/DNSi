import dgram from "node:dgram";
import net from "node:net";
import { AnswerCache } from "./cache.js";
import {
  buildQuestionQname,
  decodeEncodedText,
  parseDnsiQname,
  type ZoneConfig,
} from "./name.js";
import { RateLimiter } from "./ratelimit.js";
import { listTools, runTool } from "./tools.js";
import {
  EDNS_PAYLOAD,
  encodeResponse,
  parseQuery,
  RCODE,
  RR_A,
  UDP_MAX,
  chunkUtf8,
  type AnswerRecord,
  type QueryInfo,
} from "./wire.js";
import type { Backend } from "./backend.js";

const TTL_DYNAMIC = 60; // answers that can change (LLM output, time)
const TTL_CANONICAL = 3600; // deterministic, cache-friendly answers

/** A-mode cap: one IPv4 per 4 answer bytes (gethostbyname returns a list). */
const MAX_A_RECORDS = 64;

/** Sessions expire this long after their last chunk. */
const SESSION_TTL_MS = 10 * 60 * 1000;

export type DnsiOptions = {
  zones: ZoneConfig[];
  udpPort: number;
  tcpPort: number;
  tcpOnly?: boolean;
  backend: Backend;
  rateLimit?: { burst: number; refillPerSec: number } | null;
  maxInFlight?: number;
};

export type ResolveResult = { records: AnswerRecord[]; rcode: number };

function txtRecord(text: string, ttl: number): AnswerRecord {
  return { type: "TXT", strings: chunkUtf8(text), ttl };
}

/**
 * Compact-answer mode: pack the answer bytes into A records, 4 bytes per
 * address. Valid UTF-8 text never contains 0x00 or 0xFF, so octets stay
 * clear of the two most-filtered single-address values. The final record
 * is zero-padded; clients strip trailing NULs. A gethostbyname call
 * receives all addresses in h_addr_list, in order.
 */
function answerToARecords(text: string, ttl: number): AnswerRecord[] {
  const bytes = Buffer.from(text, "utf8").subarray(0, MAX_A_RECORDS * 4);
  const addresses: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 4) {
    const addr = Buffer.alloc(4);
    bytes.copy(addr, 0, i, Math.min(i + 4, bytes.length));
    addresses.push(addr);
  }
  if (addresses.length === 0) addresses.push(Buffer.from([0, 0, 0, 0]));
  return [{ type: "A", addresses, ttl }];
}

/** Cache key includes qtype: the same name answers TXT+CNAME or A differently. */
function cacheKey(qtype: number, qname: string): string {
  return `${qtype}:${qname}`;
}

type SessionEntry = { parts: Map<number, string>; total: number; created: number };

export class Dnsi {
  private cache = new AnswerCache(10_000);
  private readonly limiter: RateLimiter | null;
  private inFlight = 0;
  private readonly maxInFlight: number;
  private sessions = new Map<string, SessionEntry>();

  constructor(private readonly opts: DnsiOptions) {
    this.limiter = opts.rateLimit
      ? new RateLimiter(opts.rateLimit.burst, opts.rateLimit.refillPerSec)
      : null;
    this.maxInFlight = opts.maxInFlight ?? 32;
  }

  /**
   * msg -> response bytes, or null when the datagram is not a query.
   * transport="udp" applies classic-UDP (or negotiated-EDNS) truncation.
   */
  async handleQuery(
    msg: Buffer,
    clientIp: string | null,
    transport: "udp" | "tcp" = "udp",
  ): Promise<Buffer | null> {
    const q = parseQuery(msg);
    if (!q) return null;
    if (clientIp && this.limiter && !this.limiter.allow(clientIp)) {
      return encodeResponse(q.id, q.qname, q.qtype, q.qclass, [], RCODE.SERVFAIL);
    }
    const { records, rcode } = await this.resolve(q);
    const ednsPayload = q.ednsSize !== null ? EDNS_PAYLOAD : null;

    if (transport === "udp") {
      // Classic UDP caps at 512; an EDNS0 sender raises the cap to the
      // smaller of its advertised size and our 4096 ceiling.
      const limit =
        q.ednsSize !== null && q.ednsSize >= 512 ? Math.min(q.ednsSize, 4096) : UDP_MAX;
      const full = encodeResponse(q.id, q.qname, q.qtype, q.qclass, records, rcode, false, ednsPayload);
      if (full.length <= limit) return full;
      return encodeResponse(q.id, q.qname, q.qtype, q.qclass, [], rcode, true, ednsPayload);
    }
    return encodeResponse(q.id, q.qname, q.qtype, q.qclass, records, rcode, false, ednsPayload);
  }

  private async resolve(q: QueryInfo): Promise<ResolveResult> {
    const parsed = parseDnsiQname(q.qname, this.opts.zones);
    if (!parsed) return { records: [], rcode: RCODE.NXDOMAIN };
    if (parsed.kind === "unauthorized") return { records: [], rcode: RCODE.REFUSED };

    const cached = this.cache.get(cacheKey(q.qtype, q.qname));
    if (cached) return { records: cached, rcode: RCODE.NOERROR };

    switch (parsed.kind) {
      case "usage":
        return {
          records: [
            txtRecord(
              `DNSI: send a question, e.g. what-is-dnsi.ask.${this.opts.zones[0]?.zone ?? "dnsi.test"} ` +
                `(TXT over UDP/TCP). ${listTools()}`,
              TTL_CANONICAL,
            ),
          ],
          rcode: RCODE.NOERROR,
        };
      case "tool":
        return this.tool(parsed.tool, parsed.args, q.qname, q.qtype);
      case "session":
        return await this.sessionChunk(parsed.sid, parsed.n, parsed.total, parsed.chunk, q);
      case "question":
        return this.question(parsed.question, q.qname, q.qtype);
    }
  }

  private async sessionChunk(
    sid: string,
    n: number,
    total: number,
    chunk: string,
    q: QueryInfo,
  ): Promise<ResolveResult> {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now - v.created > SESSION_TTL_MS) this.sessions.delete(k);
    }

    let entry = this.sessions.get(sid);
    if (!entry || entry.total !== total) {
      entry = { parts: new Map(), total, created: now };
    }
    entry.created = now;
    entry.parts.set(n, chunk);
    this.sessions.set(sid, entry);

    if (entry.parts.size < total) {
      return {
        records: [txtRecord(`stored ${entry.parts.size}/${total}`, TTL_DYNAMIC)],
        rcode: RCODE.NOERROR,
      };
    }

    // Assemble in part order and answer the assembled question inline.
    const pieces: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const p = entry.parts.get(i);
      if (p === undefined) break;
      pieces.push(p);
    }
    this.sessions.delete(sid);
    const question = decodeEncodedText(pieces.join(""));
    return this.question(question, q.qname, q.qtype, false);
  }

  private tool(tool: string, args: string, qname: string, qtype: number): ResolveResult {
    const result = runTool(tool, args);
    if (!result) {
      return {
        records: [txtRecord(`unknown tool '${tool}'. ${listTools()}`, TTL_CANONICAL)],
        rcode: RCODE.NOERROR,
      };
    }
    const ttl = result.canonical ? TTL_CANONICAL : TTL_DYNAMIC;
    const records: AnswerRecord[] =
      qtype === RR_A ? answerToARecords(result.text, ttl) : [txtRecord(result.text, ttl)];
    if (result.canonical) this.cache.set(cacheKey(qtype, qname), records, TTL_CANONICAL);
    return { records, rcode: RCODE.NOERROR };
  }

  private async question(
    text: string,
    qname: string,
    qtype: number,
    cacheable = true,
  ): Promise<ResolveResult> {
    if (this.inFlight >= this.maxInFlight) {
      return { records: [], rcode: RCODE.SERVFAIL }; // shed load instead of piling up
    }
    this.inFlight += 1;
    let answer;
    try {
      answer = await this.opts.backend.ask(text);
    } catch {
      return { records: [], rcode: RCODE.SERVFAIL };
    } finally {
      this.inFlight -= 1;
    }

    const ttl = answer.canonical ? TTL_CANONICAL : TTL_DYNAMIC;
    let records: AnswerRecord[];
    if (qtype === RR_A) {
      // A mode cannot carry the graph; the answer text is the payload.
      records = answerToARecords(answer.text, ttl);
    } else {
      records = [txtRecord(answer.text, ttl)];
      for (const rel of answer.related.slice(0, 3)) {
        const target = buildQuestionQname(rel, this.opts.zones[0]?.zone ?? "dnsi.test");
        if (target) records.push({ type: "CNAME", target, ttl: TTL_DYNAMIC });
      }
    }
    if (cacheable) this.cache.set(cacheKey(qtype, qname), records, ttl);
    return { records, rcode: RCODE.NOERROR };
  }

  /** Header-only TC response for a query whose UDP answer would not fit. */
  truncatedResponse(msg: Buffer): Buffer | null {
    const q = parseQuery(msg);
    if (!q) return null;
    return encodeResponse(q.id, q.qname, q.qtype, q.qclass, [], RCODE.NOERROR, true);
  }
}

export type DnsiServer = {
  udpPort: number;
  tcpPort: number;
  dnsi: Dnsi;
  stop: () => Promise<void>;
};

export async function startServer(opts: DnsiOptions): Promise<DnsiServer> {
  const dnsi = new Dnsi(opts);
  const tcpSockets = new Set<net.Socket>();

  const tcp = net.createServer((socket) => {
    tcpSockets.add(socket);
    let buf = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      chain = chain.then(async () => {
        // Drain all complete framed queries currently buffered, in order.
        for (;;) {
          if (buf.length < 2) break;
          const len = buf.readUInt16BE(0);
          if (buf.length < 2 + len) break;
          const msg = Buffer.from(buf.subarray(2, 2 + len));
          buf = Buffer.from(buf.subarray(2 + len));
          const resp = await dnsi.handleQuery(msg, socket.remoteAddress ?? null, "tcp");
          if (resp) {
            const framed = Buffer.alloc(2 + resp.length);
            framed.writeUInt16BE(resp.length, 0);
            resp.copy(framed, 2);
            socket.write(framed);
          }
        }
      });
    });
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(opts.tcpPort, () => resolve());
  });

  let udp: dgram.Socket | null = null;
  let udpPort = 0;
  if (!opts.tcpOnly) {
    udp = dgram.createSocket("udp4");
    udp.on("message", (msg, rinfo) => {
      void dnsi.handleQuery(msg, rinfo.address, "udp").then((resp) => {
        if (resp) udp?.send(resp, rinfo.port, rinfo.address);
      });
    });
    udp.on("error", () => {}); // never crash on a bad datagram
    await new Promise<void>((resolve, reject) => {
      udp?.once("error", reject);
      udp?.bind(opts.udpPort, () => resolve());
    });
    udpPort = opts.udpPort === 0 ? (udp?.address().port ?? 0) : opts.udpPort;
  }

  const tcpAddress = tcp.address();
  const tcpPort = typeof tcpAddress === "object" && tcpAddress ? tcpAddress.port : opts.tcpPort;

  return {
    udpPort,
    tcpPort,
    dnsi,
    stop: async () => {
      for (const s of tcpSockets) s.destroy();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
      if (udp) {
        await new Promise<void>((resolve) => udp?.close(() => resolve()));
      }
    },
  };
}
