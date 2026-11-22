import http from "node:http";
import https from "node:https";
import type { Dnsi } from "./server.js";

/**
 * DNS-over-HTTPS (RFC 8484). A minimal, dependency-free front for the same
 * handleQuery path the UDP and TCP transports use. Supports both the GET
 * (?dns=base64url) and the POST (application/dns-message) forms. TLS is
 * expected to terminate here when certificates are configured; on a public
 * host the recommended layout is one process for plain DoH on 443 with
 * cert files from Let's Encrypt.
 */

const MAX_DOH_BODY = 64 * 1024; // DNS messages are tiny; refuse everything else

export type DohOptions = {
  port: number;
  /** TLS cert/key: omit to run plain HTTP (behind a local proxy / tests). */
  tlsCert?: string;
  tlsKey?: string;
  /** Cap concurrent in-flight queries; mirrors the UDP/TCP posture. */
  maxInFlight?: number;
};

export type DohServer = {
  port: number;
  stop: () => Promise<void>;
};

function base64UrlDecode(s: string): Buffer {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64");
}

/** Parse the /dns-query request into raw wire bytes, or null. */
function extractQuery(
  req: http.IncomingMessage,
  url: URL,
  body: Buffer | null,
): Buffer | null {
  if (req.method === "GET") {
    const dns = url.searchParams.get("dns");
    if (!dns) return null;
    return base64UrlDecode(dns);
  }
  if (req.method === "POST") {
    if (req.headers["content-type"] !== "application/dns-message") return null;
    return body && body.length > 0 ? body : null;
  }
  return null;
}

export async function startDoh(dnsi: Dnsi, opts: DohOptions): Promise<DohServer> {
  const handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DOH_BODY) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      if (!res.writableEnded) res.writeHead(400).end();
    });
    req.on("end", () => {
      if (aborted) return;
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname !== "/dns-query") {
        res.writeHead(404, { "content-type": "text/plain" }).end("not a DNS endpoint");
        return;
      }
      const body = chunks.length > 0 ? Buffer.concat(chunks) : null;
      const query = extractQuery(req, url, body);
      if (!query) {
        // RFC 8484 4.1: a malformed request is HTTP 400
        res.writeHead(400).end();
        return;
      }
      void dnsi
        .handleQuery(query, req.socket.remoteAddress ?? null, "tcp")
        .then((resp) => {
          if (!resp) {
            res.writeHead(400).end(); // not a DNS query we can parse
            return;
          }
          res.writeHead(200, {
            "content-type": "application/dns-message",
            "cache-control": "max-age=60",
          });
          res.end(resp);
        })
        .catch(() => {
          if (!res.writableEnded) res.writeHead(500).end();
        });
    });
  };

  const server =
    opts.tlsCert && opts.tlsKey
      ? https.createServer(
          { cert: opts.tlsCert, key: opts.tlsKey },
          handler,
        )
      : http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
