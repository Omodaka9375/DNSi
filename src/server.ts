import dgram from "node:dgram";
import net from "node:net";
import { AnswerCache } from "./cache.js";
import {
  buildQuestionQname,
  decodeEncodedText,
  encodedByteLength,
  MAX_SESSION_QUESTION_BYTES,
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
  RR_ANY,
  RR_TXT,
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

/** Hard ceiling on concurrently tracked sessions (memory exhaustion guard). */
const MAX_SESSIONS = 10_000;
/** Idle TCP connections are dropped after this long. */
const TCP_IDLE_TIMEOUT_MS = 30_000;
/** Per-connection TCP receive buffer cap: a peer must not be able to
 * inflate server memory while a query is in flight. */
const MAX_TCP_BUFFER = 128 * 1024;

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

/** TXT RDATA is written into a u16 RDLENGTH, so keep the total below 64KB:
 * a huge backend answer degrades to a truncated answer instead of a
 * silently wrapped, malformed packet. 60000 also leaves headroom for the
 * question name and related-question CNAMEs in the same response. */
const MAX_TXT_RDATA = 60000;

function txtRecord(text: string, ttl: number): AnswerRecord {
  const kept: Buffer[] = [];
  let total = 0;
  for (const s of chunkUtf8(text)) {
    if (total + s.length > MAX_TXT_RDATA) break;
    kept.push(s);
    total += s.length;
  }
  return { type: "TXT", strings: kept, ttl };
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

type SessionEntry = {
  /** Part number -> that part's text, still in QNAME encoding. */
  parts: Map<number, string>;
  /** Part number -> decoded byte count, for the exact session budget. */
  bytes: Map<number, number>;
  total: number;
  created: number;
};

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
      // No OPT: classic 512. With OPT: the smaller of what the requestor
      // advertised (RFC 6891) and OUR advertised size (1232, RFC 8482's
      // recommended ceiling). Honouring a requestor's 4096 instead would
      // let a spoofed source address collect a 4096-byte reply for a
      // ~40-byte query, which is textbook reflected DNS amplification.
      // Anything larger is truncated, and the client retries over TCP
      // where it is not spoofable.
      const limit =
        q.ednsSize !== null ? Math.min(q.ednsSize, EDNS_PAYLOAD) : UDP_MAX;
      const full = encodeResponse(
        q.id,
        q.qname,
        q.qtype,
        q.qclass,
        records,
        rcode,
        false,
        ednsPayload,
      );
      if (full.length <= limit) return full;
      return encodeResponse(q.id, q.qname, q.qtype, q.qclass, [], rcode, true, ednsPayload);
    }
    return encodeResponse(q.id, q.qname, q.qtype, q.qclass, records, rcode, false, ednsPayload);
  }

  private async resolve(q: QueryInfo): Promise<ResolveResult> {
    const parsed = parseDnsiQname(q.qname, this.opts.zones);
    if (!parsed) return { records: [], rcode: RCODE.NXDOMAIN };
    if (parsed.kind === "unauthorized") return { records: [], rcode: RCODE.REFUSED };
    // Dual-stack resolvers (getaddrinfo) send AAAA/HTTPS alongside A/TXT.
    // Answer NODATA (NOERROR, 0 records) immediately without touching the
    // backend or mutating session state.
    if (q.qtype !== RR_TXT && q.qtype !== RR_A && q.qtype !== RR_ANY) {
      return { records: [], rcode: RCODE.NOERROR };
    }

    const cached = this.cache.get(cacheKey(q.qtype, q.qname));
    if (cached) return { records: cached, rcode: RCODE.NOERROR };

    switch (parsed.kind) {
      case "usage":
        return {
          records: [
            txtRecord(
              `DNSi: send a question, e.g. what-is-dnsi.ask.${parsed.zone.zone} ` +
                `(TXT over UDP/TCP). ${listTools()}`,
              TTL_CANONICAL,
            ),
          ],
          rcode: RCODE.NOERROR,
        };
      case "tool":
        return this.tool(parsed.tool, parsed.args, q.qname, q.qtype);
      case "session":
        return this.sessionChunk(parsed.sid, parsed.n, parsed.total, parsed.chunk, q, parsed.zone);
      case "question":
        return this.question(parsed.question, q.qname, q.qtype, parsed.zone);
    }
  }

  /**
   * Collect one session part. Parts arrive STILL ENCODED and are joined
   * before they are decoded: a multi-byte UTF-8 character is three %XX
   * tokens, and chunkQuestion may place that boundary mid-character, so
   * decoding a part on its own would cut it in half. Decoding twice (once in
   * the parser, once here) was the original defect: it re-reads literal '-'
   * and '%' in the question as escapes.
   */
  private async sessionChunk(
    sid: string,
    n: number,
    total: number,
    encoded: string,
    q: QueryInfo,
    zone: ZoneConfig,
  ): Promise<ResolveResult> {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now - v.created > SESSION_TTL_MS) this.sessions.delete(k);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      // Age pruning alone is not enough when the per-IP limiter is bypassed
      // with spoofed UDP source addresses: every new sid is fresh state.
      // Evict oldest-created sessions down to half the cap; the scan runs
      // once per eviction batch, not once per insert.
      const entries = [...this.sessions.entries()].sort(
        (a, b) => a[1].created - b[1].created,
      );
      const target = Math.floor(MAX_SESSIONS / 2);
      for (let i = 0; i < entries.length && this.sessions.size > target; i += 1) {
        const item = entries[i];
        if (item === undefined) break;
        this.sessions.delete(item[0]);
      }
    }

    const sessionKey = `${zone.zone}:${sid}`;
    let entry = this.sessions.get(sessionKey);
    if (!entry || entry.total !== total) {
      entry = { parts: new Map(), bytes: new Map(), total, created: now };
    }
    const chunkBytes = encodedByteLength(encoded) ?? 0;
    let sum = chunkBytes;
    for (const [k, v] of entry.bytes) {
      if (k !== n) sum += v;
    }
    // The documented session budget is enforced at admission time, so the
    // assembled question handed to the backend can never exceed it.
    if (sum > MAX_SESSION_QUESTION_BYTES) {
      return {
        records: [
          txtRecord(
            `question exceeds the ${MAX_SESSION_QUESTION_BYTES}-byte session cap`,
            TTL_DYNAMIC,
          ),
        ],
        rcode: RCODE.REFUSED,
      };
    }
    entry.created = now;
    entry.parts.set(n, encoded);
    entry.bytes.set(n, chunkBytes);
    this.sessions.set(sessionKey, entry);

    if (entry.parts.size < total) {
      return {
        records: [txtRecord(`stored ${entry.parts.size}/${total}`, TTL_DYNAMIC)],
        rcode: RCODE.NOERROR,
      };
    }

    // Assemble in part order, decode once, then answer inline.
    const pieces: string[] = [];
    for (let i = 1; i <= total; i += 1) {
      const p = entry.parts.get(i);
      if (p === undefined) break;
      pieces.push(p);
    }
    this.sessions.delete(sessionKey);
    const question = decodeEncodedText(pieces.join(""));
    if (question.length === 0) return { records: [], rcode: RCODE.NXDOMAIN };
    return this.question(question, q.qname, q.qtype, zone, false);
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
    zone: ZoneConfig,
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
      // Related questions are appended to the TXT answer as "dig TXT"
      // hints rather than emitted as CNAME records: a CNAME at the same
      // owner name as a TXT record violates RFC 1034 3.6.2 / RFC 2181
      // 10.1 (a CNAME node must not hold other data), and strict
      // resolvers (Google/Cloudflare DoH JSON) SERVFAIL such responses.
      // The hints still name the zone that was queried and carry its
      // token, so following the graph on a token-protected zone works.
      let text = answer.text;
      const hints: string[] = [];
      for (const rel of answer.related.slice(0, 3)) {
        const target = buildQuestionQname(rel, zone.zone, zone.token);
        if (target) hints.push(`dig TXT ${target}`);
      }
      if (hints.length > 0) text += "\nrelated:\n  " + hints.join("\n  ");
      records = [txtRecord(text, ttl)];
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
    // Idle connections are dropped and closing sockets leave the tracking
    // set: without this, one Socket object leaks per connect/close cycle
    // and held-open connections drain file descriptors.
    socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
    socket.on("timeout", () => socket.destroy());
    socket.on("close", () => tcpSockets.delete(socket));
    let buf = Buffer.alloc(0);
    let chain: Promise<void> = Promise.resolve();
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_TCP_BUFFER) {
        socket.destroy();
        return;
      }
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
      }).catch(() => {
        // A rejection must never wedge this connection's chain for good or
        // reach Node's fatal unhandled-rejection path. Fail closed.
        socket.destroy();
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
      void dnsi
        .handleQuery(msg, rinfo.address, "udp")
        .then((resp) => {
          if (resp) udp?.send(resp, rinfo.port, rinfo.address);
        })
        .catch(() => {
          // A codec or backend bug must never reach Node's fatal
          // unhandled-rejection path. Answer nothing rather than crash.
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
