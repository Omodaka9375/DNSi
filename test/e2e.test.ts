import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EchoBackend, type Backend, type BackendAnswer } from "../src/backend.js";
import { buildQuestionQname } from "../src/name.js";
import { startServer } from "../src/server.js";
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
    zone: ZONE,
    udpPort: 0,
    tcpPort: 0,
    backend,
  });
  try {
    const first = await queryUdp(server.udpPort, qnameFor("What is DNSI?"));
    assert.equal(first.rcode, 0);
    assert.ok(first.txt.includes("DNSI (echo backend): What is DNSI?"));
    assert.ok(first.cnames.length >= 1);

    // follow the graph: the CNAME target is itself a question
    const target = first.cnames[0];
    assert.ok(target);
    const second = await queryUdp(server.udpPort, target);
    assert.equal(second.rcode, 0);
    assert.ok(second.txt.length > 0);

    // cache: same question hits the cache (2 calls so far: original + the
    // distinct related question resolved via its CNAME)
    const again = await queryUdp(server.udpPort, qnameFor("What is DNSI?"));
    assert.equal(again.txt, first.txt);
    assert.equal(backend.calls, 2);
  } finally {
    await server.stop();
  }
});

test("tcp: framed query and response work end to end", async () => {
  const server = await startServer({
    zone: ZONE,
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
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
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
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const res = await queryUdp(server.udpPort, "example.com");
    assert.equal(res.rcode, 3);
  } finally {
    await server.stop();
  }
});

test("rate limit per client ip", async () => {
  const server = await startServer({
    zone: ZONE,
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
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const res = await queryUdp(server.udpPort, `ask.${ZONE}`);
    assert.equal(res.rcode, 0);
    assert.ok(res.txt.includes("DNSI"));
  } finally {
    await server.stop();
  }
});

test("A mode: gethostbyname emulation reassembles the answer text", async () => {
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new EchoBackend() });
  try {
    const qn = qnameFor("What is DNSI?");
    const res = await queryUdp(server.udpPort, qn, "127.0.0.1", 5000, RR_A);
    assert.equal(res.rcode, 0);
    assert.ok(res.a.length >= 1);
    assert.equal(res.txt, ""); // A mode carries no TXT
    assert.equal(aRecordsToText(res.a), "DNSI (echo backend): What is DNSI?");
    // tools work the same way for constrained devices
    const hash = await queryUdp(server.udpPort, `tool.hash.hi.ask.${ZONE}`, "127.0.0.1", 5000, RR_A);
    assert.equal(aRecordsToText(hash.a).length, 64);
  } finally {
    await server.stop();
  }
});

test("A and TXT answers are cached under separate keys", async () => {
  const backend = new CountingBackend(new EchoBackend());
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend });
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
  const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new LongBackend() });
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
