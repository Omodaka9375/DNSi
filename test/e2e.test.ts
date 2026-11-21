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
import { queryTcp, queryUdp, aRecordsToText, RR_A } from "../src/query.js";

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

test("udp: question answered, related questions are resolvable CNAMEs", async () => {
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
    assert.ok(first.cnames.length >= 1);

    // follow the graph: the CNAME target is itself a question
    const target = first.cnames[0];
    assert.ok(target);
    const second = await queryUdp(server.udpPort, target);
    assert.equal(second.rcode, 0);
    assert.ok(second.txt.length > 0);

    // cache: same question hits the cache (2 calls so far: original + the
    // distinct related question resolved via its CNAME)
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

test("EDNS: large advertised payload receives the full answer over UDP", async () => {
  const server = await startServer({ zones: [{ zone: ZONE }], udpPort: 0, tcpPort: 0, backend: new LongBackend() });
  try {
    const qn = qnameFor("explain quantum computing in detail please");
    // classic UDP: TC; EDNS0 with 4096: complete
    const classic = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 16);
    assert.equal(classic.tc, true);
    const edns = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, 16, 4096);
    assert.equal(edns.tc, false);
    assert.ok(edns.txt.length > 512);
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
    assert.equal(answer.txt, `DNSi (echo backend): ${question}`);

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
    assert.equal(hit.txt, "DNSi is a question box over DNS.");
    // the related CNAME is one of the prepared questions and resolves
    assert.ok(hit.cnames.includes("what-tools-are-available.ask." + ZONE));
    const rel = await queryUdp(server.udpPort, hit.cnames[0] ?? "");
    assert.equal(rel.txt, "time, uuid, echo, hash.");

    // unknown question falls back to the default
    const miss = await queryUdp(server.udpPort, qnameFor("what is the meaning of life"));
    assert.equal(miss.txt, "This demo answers prepared questions only.");
  } finally {
    await server.stop();
  }
});
