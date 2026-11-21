import dgram from "node:dgram";
import net from "node:net";
import { AnswerCache } from "./cache.js";
import { buildQuestionQname, parseDnsiQname } from "./name.js";
import { RateLimiter } from "./ratelimit.js";
import { listTools, runTool } from "./tools.js";
import {
  encodeResponse,
  parseQuery,
  RCODE,
  chunkUtf8,
  type AnswerRecord,
  type QueryInfo,
} from "./wire.js";
import type { Backend } from "./backend.js";

const TTL_DYNAMIC = 60; // answers that can change (LLM output, time)
const TTL_CANONICAL = 3600; // deterministic, cache-friendly answers

export type DnsiOptions = {
  zone: string;
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

export class Dnsi {
  private cache = new AnswerCache(10_000);
  private readonly limiter: RateLimiter | null;
  private inFlight = 0;
  private readonly maxInFlight: number;

  constructor(private readonly opts: DnsiOptions) {
    this.limiter = opts.rateLimit
      ? new RateLimiter(opts.rateLimit.burst, opts.rateLimit.refillPerSec)
      : null;
    this.maxInFlight = opts.maxInFlight ?? 32;
  }

  /** msg -> response bytes, or null when the datagram is not a query. */
  async handleQuery(msg: Buffer, clientIp: string | null): Promise<Buffer | null> {
    const q = parseQuery(msg);
    if (!q) return null;
    if (clientIp && this.limiter && !this.limiter.allow(clientIp)) {
      return encodeResponse(q.id, q.qname, q.qtype, q.qclass, [], RCODE.SERVFAIL);
    }
    const { records, rcode } = await this.resolve(q);
    return encodeResponse(q.id, q.qname, q.qtype, q.qclass, records, rcode);
  }

  private async resolve(q: QueryInfo): Promise<ResolveResult> {
    const parsed = parseDnsiQname(q.qname, this.opts.zone);
    if (!parsed) return { records: [], rcode: RCODE.NXDOMAIN };

    const cached = this.cache.get(q.qname);
    if (cached) return { records: cached, rcode: RCODE.NOERROR };

    switch (parsed.kind) {
      case "usage":
        return {
          records: [
            txtRecord(
              `DNSI: send a question, e.g. what-is-dnsi.ask.${this.opts.zone} (TXT over UDP/TCP). ` +
                `${listTools()}`,
              TTL_CANONICAL,
            ),
          ],
          rcode: RCODE.NOERROR,
        };
      case "tool":
        return this.tool(parsed.tool, parsed.args, q.qname);
      case "question":
        return this.question(parsed.question, q.qname);
    }
  }

  private tool(tool: string, args: string, qname: string): ResolveResult {
    const result = runTool(tool, args);
    if (!result) {
      return {
        records: [txtRecord(`unknown tool '${tool}'. ${listTools()}`, TTL_CANONICAL)],
        rcode: RCODE.NOERROR,
      };
    }
    const ttl = result.canonical ? TTL_CANONICAL : TTL_DYNAMIC;
    const records: AnswerRecord[] = [txtRecord(result.text, ttl)];
    if (result.canonical) this.cache.set(qname, records, TTL_CANONICAL);
    return { records, rcode: RCODE.NOERROR };
  }

  private async question(text: string, qname: string): Promise<ResolveResult> {
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
    const records: AnswerRecord[] = [txtRecord(answer.text, ttl)];
    for (const rel of answer.related.slice(0, 3)) {
      const target = buildQuestionQname(rel, this.opts.zone);
      if (target) records.push({ type: "CNAME", target, ttl: TTL_DYNAMIC });
    }
    this.cache.set(qname, records, ttl);
    return { records, rcode: RCODE.NOERROR };
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
          const resp = await dnsi.handleQuery(msg, socket.remoteAddress ?? null);
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
      void dnsi.handleQuery(msg, rinfo.address).then((resp) => {
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
