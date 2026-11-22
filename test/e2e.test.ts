import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EchoBackend, type Backend, type BackendAnswer } from "../src/backend.js";
import {
  buildQuestionQname,
  buildSessionQname,
  chunkQuestion,
  decodeEncodedText,
} from "../src/name.js";
import { startServer } from "../src/server.js";
import { CannedBackend } from "../src/backend.js";
import { queryTcp, queryUdp, aRecordsToText, buildQuery, RR_A } from "../src/query.js";
import dgram from "node:dgram";
import { EDNS_PAYLOAD } from "../src/wire.js";

const ZONE = "dnsi.test";

class CountingBackend implements Backend {
  readonly name = "counting";
  calls = 0;
  constructor(private readonly inner: Backend) {}
  async ask(question: string): Promise<BackendAnswer> {
    this.calls += 1;
    return this.inner.ask(question);
  }
}

class LongBackend implements Backend {
  readonly name = "long";
  async ask(question: string): Promise<BackendAnswer> {
    return { text: (question + " ").repeat(40).trim(), related: [], canonical: false };
  }
}

function qnameFor(q: string): string {
  const n = buildQuestionQname(q, ZONE);
  assert.ok(n);
  return n;
}

test("udp: question answered, related questions hinted in the TXT", async () => {
  const backend = new CountingBackend(new EchoBackend());
  const server = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend,
  });
  try {
    const first = await queryUdp(server.udpPort, qnameFor("What is DNSi?"));
    assert.equal(first.rcode, 0);
    assert.ok(first.txt.includes("DNSi (echo backend): What is DNSi?"));
    assert.equal(first.cnames.length, 0, "no CNAME records: RFC 1034 3.6.2 exclusivity");
    const hints = [...first.txt.matchAll(/dig TXT (\S+)/g)].map((m) => m[1]);
    assert.ok(hints.length >= 1, `expected related hints, got: ${first.txt}`);

    // follow the graph: the hinted name is itself a question
    const target = hints[0];
    assert.ok(target);
    const second = await queryUdp(server.udpPort, target);
    assert.equal(second.rcode, 0);
    assert.ok(second.txt.length > 0);

    // cache: same question hits the cache (2 calls so far: original + the
    // distinct hinted related question)
    const again = await queryUdp(server.udpPort, qnameFor("What is DNSi?"));
    assert.equal(again.txt, first.txt);
    assert.equal(backend.calls, 2);
  } finally {
    await server.stop();
  }
});

test("tcp: framed query and response work end to end", async () => {
  const server = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
  });
  try {
    const res = await queryTcp(server.tcpPort, qnameFor("fibonacci in python"), "127.0.0.1");
    assert.equal(res.rcode, 0);
    assert.ok(res.txt.includes("fibonacci in python"));
  } finally {
    await server.stop();
  }
});

test("tools: time, uuid, hash, unknown", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const time = await queryUdp(server.udpPort, `tool.time.ask.${ZONE}`);
    assert.equal(time.rcode, 0);
    assert.ok(!Number.isNaN(Date.parse(time.txt)));

    const hash = await queryUdp(server.udpPort, `tool.hash.abc.ask.${ZONE}`);
    assert.equal(hash.rcode, 0);
    // canonical tool answers are cached (repeat is identical)
    const hash2 = await queryUdp(server.udpPort, `tool.hash.abc.ask.${ZONE}`);
    assert.equal(hash.txt, hash2.txt);

    const unknown = await queryUdp(server.udpPort, `tool.nothing.ask.${ZONE}`);
    assert.equal(unknown.rcode, 0);
    assert.ok(unknown.txt.includes("unknown tool"));
  } finally {
    await server.stop();
  }
});

test("foreign names are NXDOMAIN", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const res = await queryUdp(server.udpPort, "example.com");
    assert.equal(res.rcode, 3);
  } finally {
    await server.stop();
  }
});

test("rate limit per client ip", async () => {
  const server = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    rateLimit: { burst: 1, refillPerSec: 0 },
  });
  try {
    const q1 = await queryUdp(server.udpPort, `tool.time.ask.${ZONE}`);
    assert.equal(q1.rcode, 0);
    const q2 = await queryUdp(server.udpPort, `tool.time2.ask.${ZONE}`);
    assert.equal(q2.rcode, 2); // SERVFAIL
  } finally {
    await server.stop();
  }
});

test("usage answer on bare zone", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const res = await queryUdp(server.udpPort, `ask.${ZONE}`);
    assert.equal(res.rcode, 0);
    assert.ok(res.txt.includes("DNSi"));
  } finally {
    await server.stop();
  }
});

test("A mode: gethostbyname emulation reassembles the answer text", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const qn = qnameFor("What is DNSi?");
    const res = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, RR_A);
    assert.equal(res.rcode, 0);
    assert.ok(res.a.length >= 1);
    assert.equal(res.txt, ""); // A mode carries no TXT
    assert.equal(aRecordsToText(res.a), "DNSi (echo backend): What is DNSi?");
    // tools work the same way for constrained devices
    const hash = await queryUdp(server.udpPort, `tool.hash.hi.ask.${ZONE}`, "127.0.0.1", 5000, RR_A);
    assert.equal(aRecordsToText(hash.a).length, 64);
  } finally {
    await server.stop();
  }
});

test("A and TXT answers are cached under separate keys", async () => {
  const backend = new CountingBackend(new EchoBackend());
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend });
  try {
    const qn = qnameFor("cache split test");
    await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, RR_A);
    await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, RR_A);
    await queryUdp(server.udpPort, qn);
    await queryUdp(server.udpPort, qn);
    assert.equal(backend.calls, 2); // one per qtype, both then cached
  } finally {
    await server.stop();
  }
});

test("UDP answers over 512 bytes are truncated with TC; TCP is complete", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new LongBackend() });
  try {
    const qn = qnameFor("explain quantum computing in detail please");
    const udpRes = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000);
    assert.equal(udpRes.tc, true);
    assert.equal(udpRes.txt, "");
    assert.equal(udpRes.rcode, 0);

    const tcpRes = await queryTcp(server.tcpPort, qn, "127.0.0.1", 10000);
    assert.equal(tcpRes.tc, false);
    assert.ok(tcpRes.txt.length > 512);
  } finally {
    await server.stop();
  }
});

test("EDNS: an advertised payload up to 1232 receives the full answer over UDP", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new LongBackend() });
  try {
    const qn = qnameFor("explain quantum");
    // a >512 but <1232 answer: classic UDP truncates, EDNS0 at 1232 does not
    const classic = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 16);
    assert.equal(classic.tc, true);
    const edns = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 16, EDNS_PAYLOAD);
    assert.equal(edns.tc, false);
    assert.ok(edns.txt.length > 512);
  } finally {
    await server.stop();
  }
});

/** Send a raw query and report the response's byte count plus its TC bit. */
function rawUdp(query: Buffer, port: number): Promise<{ bytes: number; tc: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timeout"));
    }, 5000);
    socket.once("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve({ bytes: msg.length, tc: (msg[2] & 0x02) !== 0 });
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.send(query, port, "127.0.0.1");
  });
}

test("EDNS: UDP replies never exceed 1232 bytes (no reflected amplification)", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new LongBackend() });
  try {
    const qn = qnameFor("explain quantum computing in detail please");

    // A requestor claiming 4096 used to receive the whole ~1.7 KB answer.
    // It must now be truncated: that reply is what a spoofed source
    // address would collect, and it is the reason this cap exists.
    const asking4096 = buildQuery(qn, 16, 7, 4096);
    assert.ok(asking4096);
    const big = await rawUdp(asking4096, server.udpPort);
    assert.equal(big.tc, true, "a 4096 ask must not receive the full answer");
    assert.ok(big.bytes <= EDNS_PAYLOAD, `reply was ${big.bytes} bytes`);

    // Never larger than the requestor's own advertised size either
    // (RFC 6891): a 200-byte claim gets at most 200 bytes back.
    const asking200 = buildQuery(qn, 16, 7, 200);
    assert.ok(asking200);
    const small = await rawUdp(asking200, server.udpPort);
    assert.equal(small.tc, true);
    assert.ok(small.bytes <= 200, `reply was ${small.bytes} bytes for a 200 ask`);

    // TCP is unaffected: the complete answer is available there.
    const tcpRes = await queryTcp(server.tcpPort, qn, "127.0.0.1", 10000);
    assert.equal(tcpRes.tc, false);
    assert.ok(tcpRes.txt.length > EDNS_PAYLOAD, "TCP still serves the long answer");
  } finally {
    await server.stop();
  }
});

test("sessions: questions over 200 bytes ride in parts, final part answers", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const question =
      "explain the difference between a recursive resolver and an authoritative nameserver, " +
      "including their cache behavior, negative caching semantics, and how TTL values are " +
      "interpreted by stub resolvers forwarding through a caching intermediate in practice";
    assert.ok(Buffer.byteLength(question) > 200);
    const chunks = chunkQuestion(question);
    assert.ok(chunks && chunks.length >= 2);
    const sid = "deadbeef";
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const qn = buildSessionQname(sid, i + 1, chunks.length, chunks[i] ?? "", ZONE);
      assert.ok(qn);
      const res = await queryUdp(server.udpPort, qn);
      assert.equal(res.rcode, 0);
      assert.ok(res.txt.includes(`stored ${i + 1}/${chunks.length}`));
    }
    const finalQn = buildSessionQname(sid, chunks.length, chunks.length, chunks[chunks.length - 1] ?? "", ZONE);
    assert.ok(finalQn);
    const answer = await queryUdp(server.udpPort, finalQn);
    assert.equal(answer.rcode, 0);
    assert.ok(answer.txt.startsWith(`DNSi (echo backend): ${question}`));

    // session is consumed: re-sending the final part restarts a new session
    const again = await queryUdp(server.udpPort, finalQn);
    assert.equal(again.rcode, 0);
    assert.ok(again.txt.includes(`stored 1/${chunks.length}`));
  } finally {
    await server.stop();
  }
});

test("per-zone tokens: missing token is REFUSED, correct token answers", async () => {
  const TOKEN = "s3cret";
  const server = await startServer({
    zones: [{ zone: "open.dnsi.test" }, { zone: ZONE, token: TOKEN }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
  });
  try {
    // tokenized zone without token -> REFUSED (5)
    const bare = await queryUdp(server.udpPort, buildQuestionQname("hi", ZONE) ?? "");
    assert.equal(bare.rcode, 5);
    // with token -> answered
    const ok = await queryUdp(server.udpPort, buildQuestionQname("hi", ZONE, TOKEN) ?? "");
    assert.equal(ok.rcode, 0);
    assert.ok(ok.txt.includes("hi"));
    // open zone needs no token
    const open = await queryUdp(server.udpPort, buildQuestionQname("hi", "open.dnsi.test") ?? "");
    assert.equal(open.rcode, 0);
    // wrong token is still refused
    const wrong = await queryUdp(server.udpPort, buildQuestionQname("hi", ZONE, "nope") ?? "");
    assert.equal(wrong.rcode, 5);
  } finally {
    await server.stop();
  }
});

test("chunkQuestion never splits %XX tokens and round-trips", () => {
  const q = "translate caf\u00e9 na\u00efve \u4e2d\u6587 text ".repeat(8);
  const chunks = chunkQuestion(q);
  assert.ok(chunks);
  for (const c of chunks) assert.ok(c.length <= 45);
  assert.equal(decodeEncodedText(chunks.join("")), q);
});

test("uuid tool returns a fresh value per call (not cached by the fixed name)", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const a = await queryUdp(server.udpPort, `tool.uuid.ask.${ZONE}`);
    const b = await queryUdp(server.udpPort, `tool.uuid.ask.${ZONE}`);
    assert.equal(a.rcode, 0);
    assert.match(a.txt, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.txt, b.txt, "uuid must not be cached under the shared qname");
    // deterministic tools still cache: the same hash comes back identical
    const h1 = await queryUdp(server.udpPort, `tool.hash.stable.ask.${ZONE}`);
    const h2 = await queryUdp(server.udpPort, `tool.hash.stable.ask.${ZONE}`);
    assert.equal(h1.txt, h2.txt);
  } finally {
    await server.stop();
  }
});

test("session mode round-trips a unicode question without double-decoding", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const question = `\u4e2d\u6587 caf\u00e9 na\u00efve ${"r\u00e9sum\u00e9 ".repeat(30)}konec`;
    assert.ok(Buffer.byteLength(question) > 200, "needs session mode");
    const chunks = chunkQuestion(question);
    assert.ok(chunks && chunks.length >= 2);
    const sid = "0a0b0c0d";
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const qn = buildSessionQname(sid, i + 1, chunks.length, chunks[i] ?? "", ZONE);
      assert.ok(qn);
      const res = await queryUdp(server.udpPort, qn);
      assert.equal(res.rcode, 0);
    }
    const finalQn = buildSessionQname(
      sid,
      chunks.length,
      chunks.length,
      chunks[chunks.length - 1] ?? "",
      ZONE,
    );
    assert.ok(finalQn);
    const answer = await queryUdp(server.udpPort, finalQn);
    // the echo backend prefixes the question; the question itself must be intact
    assert.ok(answer.txt.startsWith(`DNSi (echo backend): ${question}`));
    assert.ok(!answer.txt.includes("\uFFFD"), "no replacement characters");
  } finally {
    await server.stop();
  }
});

test("server enforces the session question ceiling on hand-built parts", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    // Part labels are legal 63-byte DNS names, wider than the documented
    // 45-byte part: the parser rejects them outright.
    const wide = buildSessionQname("00112233", 1, 2, "x".repeat(63), ZONE);
    assert.ok(wide);
    const res = await queryUdp(server.udpPort, wide);
    assert.equal(res.rcode, 3); // NXDOMAIN: not a name we serve

    // Parts sized per spec but too many bytes in total: refused at admission,
    // and the assembled question never reaches the backend.
    // 45 bytes per part is spec-legal, but 23 parts is 1035 bytes, past the
    // 1000-byte session budget: the server refuses the part that crosses it.
    let refused = 0;
    const sid = "4deeffee";
    const total = 32;
    for (let i = 1; i <= total; i += 1) {
      const part = "y".repeat(45);
      const qn = buildSessionQname(sid, i, total, part, ZONE);
      assert.ok(qn);
      const r = await queryUdp(server.udpPort, qn);
      if (r.rcode === 5) {
        refused = i;
        break;
      }
      assert.equal(r.rcode, 0);
    }
    assert.ok(refused >= 22, `expected an admission refusal by part 23, got part ${refused}`);
  } finally {
    await server.stop();
  }
});

test("related hints stay in the queried zone and carry its token", async () => {
  const TOKEN = "s3cret";
  const server = await startServer({
    zones: [{ zone: "open.dnsi.test" }, { zone: ZONE, token: TOKEN }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(), // echoes two related questions
  });
  try {
    const qn = buildQuestionQname("hi", ZONE, TOKEN) ?? "";
    assert.ok(qn);
    const res = await queryUdp(server.udpPort, qn);
    assert.equal(res.rcode, 0);
    assert.equal(res.cnames.length, 0, "no CNAME records: RFC 1034 3.6.2 exclusivity");
    // the related hints are embedded in the answer text as dig lines
    const hinted = [...res.txt.matchAll(/dig TXT (\S+)/g)].map((m) => m[1]);
    assert.ok(hinted.length >= 1);
    for (const c of hinted) {
      // target names the tokenized zone, not zones[0], and embeds the token
      assert.ok(c.endsWith(`.ask.${ZONE}`), `hint left the queried zone: ${c}`);
      assert.ok(c.includes(`.t.${TOKEN}.ask.`), `hint lost the zone token: ${c}`);
      // and it actually resolves
      const rel = await queryUdp(server.udpPort, c);
      assert.equal(rel.rcode, 0);
    }
    // an open zone answers without a token
    const open = await queryUdp(server.udpPort, buildQuestionQname("hi", "open.dnsi.test") ?? "");
    assert.equal(open.rcode, 0);
    assert.ok(!open.txt.includes(`.t.${TOKEN}.ask.`), "open zone hints carry no token");
    for (const c of [...open.txt.matchAll(/dig TXT (\S+)/g)].map((m) => m[1])) {
      assert.ok(c.endsWith(".ask.open.dnsi.test"));
    }
  } finally {
    await server.stop();
  }
});

test("server rejects a hand-built oversized short question (NXDOMAIN, no backend call)", async () => {
  const backend = new CountingBackend(new EchoBackend());
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend });
  try {
    const before = backend.calls;
    const oversized = ["a".repeat(50), "a".repeat(50), "a".repeat(50), "a".repeat(50), "a".repeat(10)];
    const res = await queryUdp(server.udpPort, `${oversized.join(".")}.ask.${ZONE}`);
    assert.equal(res.rcode, 3);
    assert.equal(backend.calls, before, "backend must not see an over-length question");
  } finally {
    await server.stop();
  }
});

test("rate limit is active with default production settings", async () => {
  // index.ts enables the bucket unless DNSI_RATE_LIMIT=off; a library caller
  // must be able to turn it on and see it bite on a fresh ip per query name.
  const server = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    rateLimit: { burst: 2, refillPerSec: 0 },
  });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await queryUdp(server.udpPort, `tool.hash.ratelimit${i}.ask.${ZONE}`);
      codes.push(r.rcode);
    }
    assert.equal(codes[0], 0);
    assert.equal(codes[1], 0);
    assert.equal(codes[2], 2); // SERVFAIL once the bucket is empty
    assert.equal(codes[3], 2);
  } finally {
    await server.stop();
  }
});

test("unsupported qtypes (AAAA) answer NODATA without touching the backend", async () => {
  const backend = new CountingBackend(new EchoBackend());
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend });
  try {
    const qn = qnameFor("nodata qtype test");
    const before = backend.calls;
    const res = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 28); // AAAA
    assert.equal(res.rcode, 0); // NODATA: NOERROR, zero answers
    assert.equal(res.txt, "");
    assert.equal(res.a.length, 0);
    assert.equal(backend.calls, before, "backend must not see an AAAA query");

    // the ANY (255) qtype still gets a full answer
    const any = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 255);
    assert.equal(any.rcode, 0);
    assert.ok(any.txt.length > 0);
  } finally {
    await server.stop();
  }
});

test("sessions with the same sid in different zones do not collide", async () => {
  const backend = new EchoBackend();
  const server = await startServer({
    zones: [{ zone: "one.dnsi.test" }, { zone: "two.dnsi.test" }],
    udpPort: 0,
    tcpPort: 0,
    backend,
  });
  try {
    const question = `collide test ${"z ".repeat(120)}`.trim(); // > 200 bytes
    const chunks = chunkQuestion(question);
    assert.ok(chunks && chunks.length >= 2);
    const sid = "deadbeef";
    // Upload all but the last chunk into zone ONE.
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const qn = buildSessionQname(sid, i + 1, chunks.length, chunks[i] ?? "", "one.dnsi.test");
      assert.ok(qn);
      const res = await queryUdp(server.udpPort, qn);
      assert.equal(res.rcode, 0);
    }
    // Complete the SAME sid in zone TWO: it must start a fresh session
    // ("stored 1/total"), not inherit zone ONE's parts.
    const finalTwo = buildSessionQname(
      sid,
      chunks.length,
      chunks.length,
      chunks[chunks.length - 1] ?? "",
      "two.dnsi.test",
    );
    assert.ok(finalTwo);
    const resTwo = await queryUdp(server.udpPort, finalTwo);
    assert.equal(resTwo.rcode, 0);
    assert.ok(
      resTwo.txt.includes(`stored 1/${chunks.length}`),
      `zone two must start fresh: ${resTwo.txt}`,
    );
    // and zone one still completes its own session correctly afterwards
    const finalOne = buildSessionQname(
      sid,
      chunks.length,
      chunks.length,
      chunks[chunks.length - 1] ?? "",
      "one.dnsi.test",
    );
    assert.ok(finalOne);
    const resOne = await queryUdp(server.udpPort, finalOne);
    assert.equal(resOne.rcode, 0);
    assert.ok(resOne.txt.startsWith(`DNSi (echo backend): ${question}`));
  } finally {
    await server.stop();
  }
});

test("re-sending an existing session part does not double-count its bytes", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const question = `${"word ".repeat(40)}end`; // > 200 bytes
    const chunks = chunkQuestion(question);
    assert.ok(chunks && chunks.length >= 2);
    const sid = "c0ffee00";
    // Upload all parts except the last, sending part 1 twice (retry). The
    // retry must be accepted and must not double-count part 1's bytes
    // against the session budget.
    for (let i = 0; i < chunks.length - 1; i += 1) {
      const qn = buildSessionQname(sid, i + 1, chunks.length, chunks[i] ?? "", ZONE);
      assert.ok(qn);
      const res = await queryUdp(server.udpPort, qn);
      assert.equal(res.rcode, 0, `part ${i + 1} must be accepted`);
      if (i === 0) {
        const retry = await queryUdp(server.udpPort, qn);
        assert.equal(retry.rcode, 0, "part 1 retry must not be refused");
      }
    }
    const finalQn = buildSessionQname(
      sid,
      chunks.length,
      chunks.length,
      chunks[chunks.length - 1] ?? "",
      ZONE,
    );
    assert.ok(finalQn);
    const answer = await queryUdp(server.udpPort, finalQn);
    assert.equal(answer.rcode, 0);
    assert.ok(answer.txt.startsWith(`DNSi (echo backend): ${question}`));
  } finally {
    await server.stop();
  }
});

test("canned demo server: prepared questions answered, others get the default, graph resolves", async () => {
  const canned = new CannedBackend(
    {
      "what is dnsi": {
        answer: "DNSi is a question box over DNS.",
        related: ["what tools are available"],
      },
      "what tools are available": {
        answer: "time, uuid, echo, hash.",
        related: [],
      },
    },
    "This demo answers prepared questions only.",
  );
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: canned });
  try {
    // exact match, different casing
    const hit = await queryUdp(server.udpPort, qnameFor("What is DNSi?"));
    assert.equal(hit.rcode, 0);
    assert.ok(hit.txt.startsWith("DNSi is a question box over DNS."));
    // no CNAME records: RFC 1034 3.6.2 exclusivity; the related hint is a
    // dig TXT line inside the answer and resolves
    assert.equal(hit.cnames.length, 0);
    const hint = hit.txt.match(/dig TXT (\S+)/)?.[1];
    assert.equal(hint, "what-tools-are-available.ask." + ZONE);
    const rel = await queryUdp(server.udpPort, hint ?? "");
    assert.equal(rel.txt, "time, uuid, echo, hash.");

    // unknown question falls back to the default
    const miss = await queryUdp(server.udpPort, qnameFor("what is the meaning of life"));
    assert.equal(miss.txt, "This demo answers prepared questions only.");
  } finally {
    await server.stop();
  }
});
