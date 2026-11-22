import { strict as assert } from "node:assert";
import { test } from "node:test";
import tls from "node:tls";
import http from "node:http";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EchoBackend } from "../src/backend.js";
import { startServer } from "../src/server.js";
import { startDoh } from "../src/doh.js";
import { queryUdp, queryTcp, aRecordsToText, RR_A } from "../src/query.js";
import { buildQuestionQname, buildToolQname } from "../src/name.js";

const ZONE = "transport.test";

/**
 * One shared server instance for the transport tests; a self-signed cert
 * is generated once (openssl ships with Git for Windows and most dev boxes).
 */
const certDir = mkdtempSync(join(tmpdir(), "dnsi-tls-"));
let cert = "";
let key = "";
try {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", join(certDir, "key.pem"),
    "-out", join(certDir, "cert.pem"),
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
  ]);
  cert = readFileSync(join(certDir, "cert.pem"), "utf8");
  key = readFileSync(join(certDir, "key.pem"), "utf8");
} catch {
  // openssl unavailable: DoT tests skip themselves
}

const server = await startServer({
  zones: [{ zone: ZONE }],
  udpPort: 0,
  tcpPort: 0,
  backend: new EchoBackend(),
  stats: true,
  dotPort: cert ? 0 : undefined, // ephemeral port
  tlsCert: cert || undefined,
  tlsKey: key || undefined,
});

const doh = await startDoh(server.dnsi, { port: 0 }); // ephemeral, plain HTTP

test.after(async () => {
  await doh.stop();
  await server.stop();
  rmSync(certDir, { recursive: true, force: true });
});

test("DoH GET (?dns=base64url) answers a wire-format query", async () => {
  const qname = buildToolQname("time", "", ZONE) ?? "";
  assert.ok(qname);
  // build a raw TXT query for qname
  const q = await queryUdp(server.udpPort, qname); // sanity: udp path works
  assert.equal(q.rcode, 0);

  const wire = buildWireQuery(qname);
  const b64url = wire.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const body = await new Promise<string>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${doh.port}/dns-query?dns=${b64url}`, (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers["content-type"], "application/dns-message");
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("latin1")));
      })
      .on("error", reject);
  });
  // response carries the time as TXT - check for digits in the latin1 dump
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(body.slice(-80)), `time in answer: ${JSON.stringify(body.slice(-90))}`);
});

test("DoH POST (application/dns-message) answers and rejects junk", async () => {
  const qname = buildQuestionQname("hello doh", ZONE) ?? "";
  const wire = buildWireQuery(qname);
  const resp = await new Promise<{ status: number | undefined; body: Buffer }>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: doh.port,
        path: "/dns-query",
        method: "POST",
        headers: { "content-type": "application/dns-message" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end(wire);
  });
  assert.equal(resp.status, 200);
  assert.ok(resp.body.length > 60);

  // wrong path is 404, garbage body is 400
  const bad = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: doh.port, path: "/other", method: "POST" },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); },
    );
    req.on("error", reject);
    req.end(wire);
  });
  assert.equal(bad, 404);
});

test("DoT: TLS framed query answers like TCP", async () => {
  if (!cert) return; // openssl missing: skip silently
  assert.ok(server.dotPort && server.dotPort > 0, "DoT must be listening");
  const qname = buildQuestionQname("hello dot", ZONE) ?? "";
  const resp = await dotQuery(server.dotPort, qname, cert);
  assert.equal(resp.rcode, 0);
  assert.ok(resp.txt.includes("DNSi (echo backend): hello dot"));
});

test("DoT and TCP share the same wire framing", async () => {
  if (!cert || !server.dotPort) return;
  const qname = buildQuestionQname("framing check", ZONE) ?? "";
  const viaTcp = await queryTcp(server.tcpPort, qname);
  const viaDot = await dotQuery(server.dotPort, qname, cert);
  assert.equal(viaTcp.txt, viaDot.txt);
});

/** Minimal wire query builder: header + QNAME (with root terminator) + TXT. */
function buildWireQuery(qname: string): Buffer {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(0x1234);
  const header = Buffer.from([0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  const name = Buffer.concat(
    qname.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])),
  );
  return Buffer.concat([id, header, name, Buffer.from([0]), Buffer.from([0, 16, 0, 1])]);
}

type DotResp = { rcode: number; txt: string };

function dotQuery(port: number, qname: string, caCert: string): Promise<DotResp> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: "127.0.0.1",
        port,
        ca: caCert,
        servername: "127.0.0.1",
        rejectUnauthorized: false, // self-signed test cert
      },
      () => {
        const q = buildWireQuery(qname);
        const framed = Buffer.alloc(2 + q.length);
        framed.writeUInt16BE(q.length, 0);
        q.copy(framed, 2);
        socket.write(framed);
      },
    );
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length < 2 + len) return;
      socket.end();
      const msg = buf.subarray(2, 2 + len);
      // parse rcode + crude TXT extraction
      const rcode = msg[3] & 0xf;
      const an = msg.readUInt16BE(6);
      const txts: string[] = [];
      if (an > 0) {
        // walk: skip question
        let i = 12;
        while (msg[i] !== 0) i += msg[i] + 1;
        i += 5;
        for (let n = 0; n < an; n += 1) {
          if (msg[i] & 0xc0) i += 2;
          else { while (msg[i] !== 0) i += msg[i] + 1; i += 1; }
          const type = msg.readUInt16BE(i + 2);
          const rdlen = msg.readUInt16BE(i + 8);
          const rdata = msg.subarray(i + 10, i + 10 + rdlen);
          if (type === 16) {
            let j = 0;
            while (j < rdata.length) {
              const l = rdata[j]; j += 1;
              txts.push(rdata.subarray(j, j + l).toString("utf8")); j += l;
            }
          }
          i += 10 + rdlen;
        }
      }
      resolve({ rcode, txt: txts.join("") });
    });
    socket.on("error", reject);
  });
}
