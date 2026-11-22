import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Counters } from "../src/counters.js";
import { startServer } from "../src/server.js";
import { EchoBackend } from "../src/backend.js";
import { buildQuestionQname } from "../src/name.js";
import { queryUdp } from "../src/query.js";

const ZONE = "counters.test";

test("counters: inc/get/snapshot/load arithmetic", () => {
  const c = new Counters();
  assert.equal(c.get("x"), 0);
  c.inc("x");
  c.inc("x", 4);
  assert.equal(c.get("x"), 5);
  assert.equal(c.get("y"), 0);
  c.inc("y", 0); // non-positive increments are ignored
  assert.equal(c.get("y"), 0);
  const snap = c.snapshot();
  assert.deepEqual(snap, { x: 5 });
  const c2 = new Counters();
  c2.load({ x: 2, bad: "no", also: -1 });
  assert.equal(c2.get("x"), 2);
  assert.equal(c2.get("bad"), 0);
});

test("counters: uptime formatting", () => {
  assert.equal(Counters.humanUptime(0), "0s");
  assert.equal(Counters.humanUptime(45_000), "45s");
  assert.equal(Counters.humanUptime(4 * 60_000), "4m0s");
  assert.equal(Counters.humanUptime(3 * 3600_000 + 5 * 60_000), "3h5m");
});

test("stats.ask.<zone>: disabled by default, enabled with stats: true", async () => {
  const off = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
  });
  try {
    const q = await queryUdp(off.udpPort, `stats.ask.${ZONE}`);
    assert.equal(q.rcode, 3, "stats name is NXDOMAIN when not enabled");
  } finally {
    await off.stop();
  }

  const on = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    stats: true,
  });
  try {
    // generate traffic: two questions, a tool call, another question that
    // is NOT a prepared one (echo backend still answers it - what counts
    // is that it hit the backend rather than the cache)
    await queryUdp(on.udpPort, buildQuestionQname("hello", ZONE) ?? "");
    await queryUdp(on.udpPort, buildQuestionQname("second", ZONE) ?? "");
    await queryUdp(on.udpPort, `tool.hash.hello.ask.${ZONE}`);
    await queryUdp(on.udpPort, `tool.hash.hello.ask.${ZONE}`); // cache hit
    await queryUdp(on.udpPort, buildQuestionQname("third one", ZONE) ?? "");
    const s = await queryUdp(on.udpPort, `stats.ask.${ZONE}`);
    assert.equal(s.rcode, 0);
    const text = s.txt;
    assert.ok(text.includes("uptime"), text);
    assert.ok(text.includes("questions 3"), text);
    assert.ok(text.includes("tools 1"), text);
    assert.ok(text.includes("cache-hits 1 (25% hit)"), text);
    assert.ok(text.includes("hash 1"), text);
    // NXDOMAIN counter: names OUTSIDE the zone are the NXDOMAIN path
    // (everything inside the zone parses as a question).
    const foreign = await queryUdp(on.udpPort, `what-is-this.other-zone.example`);
    assert.equal(foreign.rcode, 3);
    const s2 = await queryUdp(on.udpPort, `stats.ask.${ZONE}`);
    assert.ok(s2.txt.includes("nxdomain 1"), s2.txt);
  } finally {
    await on.stop();
  }
});

test("stats: counters persist across a restart via the snapshot file", async () => {
  const file = `${process.cwd()}/.tmp-stats.json`;
  const first = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    stats: true,
    statsFile: file,
    statsSaveMs: 50, // fast save for the test
  });
  try {
    await queryUdp(first.udpPort, buildQuestionQname("persist me", ZONE) ?? "");
    await new Promise((r) => setTimeout(r, 120)); // allow one save tick
  } finally {
    await first.stop();
  }
  const second = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    stats: true,
    statsFile: file,
  });
  try {
    // the stats query itself must not be counted as a question, and the
    // snapshot from the first process must be visible in the second
    const s = await queryUdp(second.udpPort, `stats.ask.${ZONE}`);
    assert.equal(s.rcode, 0);
    assert.ok(
      /questions [1-9]/.test(s.txt),
      `restored snapshot should show at least the first process's question: ${s.txt}`,
    );
  } finally {
    await second.stop();
  }
});

test("nxdomain counter: names outside the zone", async () => {
  const server = await startServer({
    zones: [{ zone: ZONE }],
    udpPort: 0,
    tcpPort: 0,
    backend: new EchoBackend(),
    stats: true,
  });
  try {
    const res = await queryUdp(server.udpPort, `foreign-name.example.com`);
    assert.equal(res.rcode, 3, "names outside our zones must be NXDOMAIN");
    const s = await queryUdp(server.udpPort, `stats.ask.${ZONE}`);
    assert.ok(s.txt.includes("nxdomain 1"), s.txt);
  } finally {
    await server.stop();
  }
});
