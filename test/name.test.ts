import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildQuestionQname,
  buildToolQname,
  decodeEncodedText,
  parseDnsiQname,
} from "../src/name.js";
import { chunkUtf8, decodeNameAt } from "../src/wire.js";

test("buildToolQname encodes args and token, parses back", () => {
  const zone = "dnsi.test";
  const qname = buildToolQname("echo", "hello world", zone, "s3cret");
  assert.ok(qname);
  // the space encodes as '-', the zone token embeds as t.<token>
  assert.ok(qname.startsWith("tool.echo.hello-world.t.s3cret.ask.dnsi.test"));
  const parsed = parseDnsiQname(qname, [{ zone, token: "s3cret" }]);
  assert.ok(parsed);
  if (parsed.kind === "tool") {
    assert.equal(parsed.tool, "echo");
    assert.equal(parsed.args, "hello world");
  } else {
    assert.fail("expected tool query");
  }
});

test("buildToolQname: no args, unknown tool name rejected, oversize args rejected", () => {
  const zone = "dnsi.test";
  assert.equal(buildToolQname("time", "", zone), `tool.time.ask.${zone}`);
  assert.equal(buildToolQname("bad tool!", "", zone), null);
  assert.equal(buildToolQname("echo", "a".repeat(201), zone), null);
});

test("question roundtrip preserves ascii case and punctuation", () => {
  const zone = "dnsi.test";
  const q = "What is DNSi? (really)";
  const qname = buildQuestionQname(q, zone);
  assert.ok(qname);
  const parsed = parseDnsiQname(qname, [{ zone }]);
  assert.ok(parsed);
  assert.equal(parsed.kind, "question");
  if (parsed.kind === "question") {
    assert.equal(parsed.question, q);
  }
});

test("question roundtrip preserves unicode", () => {
  const zone = "dnsi.test";
  const q = "translate h\u00e9llo \u2192 \u4e2d\u6587 \u2764";
  const qname = buildQuestionQname(q, zone);
  assert.ok(qname);
  const parsed = parseDnsiQname(qname, [{ zone }]);
  assert.ok(parsed);
  if (parsed.kind === "question") assert.equal(parsed.question, q);
});

test("long questions are rejected, not silently truncated", () => {
  const zone = "dnsi.test";
  const long = "a".repeat(201);
  assert.equal(buildQuestionQname(long, zone), null);
  const ok = "a".repeat(200);
  assert.ok(buildQuestionQname(ok, zone));
});

test("tool qnames parse with decoded args", () => {
  const zone = "dnsi.test";
  const parsed = parseDnsiQname("tool.echo.hello%20world.ask." + zone, [{ zone }]);
  assert.ok(parsed);
  if (parsed.kind === "tool") {
    assert.equal(parsed.tool, "echo");
    assert.equal(parsed.args, "hello world");
  } else {
    assert.fail("expected tool query");
  }
});

test("bare zone returns usage", () => {
  const parsed = parseDnsiQname("ask.dnsi.test", [{ zone: "dnsi.test" }]);
  assert.ok(parsed);
  assert.equal(parsed.kind, "usage");
});

test("foreign names return null (NXDOMAIN)", () => {
  assert.equal(parseDnsiQname("example.com", [{ zone: "dnsi.test" }]), null);
});

test("chunkUtf8 respects 255 byte limit and unicode boundaries", () => {
  const text = "\u4e2d\u6587".repeat(500); // 3 bytes per char
  const chunks = chunkUtf8(text);
  for (const c of chunks) {
    assert.ok(c.length <= 255);
  }
  const joined = Buffer.concat(chunks).toString("utf8");
  assert.equal(joined, text);
  // every chunk must decode as valid UTF-8 (no replacement chars)
  for (const c of chunks) {
    assert.ok(!c.toString("utf8").includes("\uFFFD"));
  }
});

test("decodeEncodedText rejects malformed escapes", () => {
  assert.equal(decodeEncodedText("%2"), "");
  assert.equal(decodeEncodedText("%ZZ"), "");
});

test("parser enforces the 200-byte question ceiling, not just the builder", () => {
  const zone = "dnsi.test";
  // The builder refuses a 201-byte question, and the parser must refuse it
  // too: a hand-built client cannot use the parse path to smuggle one in.
  // These labels are legal DNS names and fit the 253-octet wire limit.
  const oversized = ["a".repeat(50), "a".repeat(50), "a".repeat(50), "a".repeat(50), "a".repeat(10)];
  assert.equal(buildQuestionQname("a".repeat(201), zone), null);
  assert.equal(parseDnsiQname(`${oversized.join(".")}.ask.${zone}`, [{ zone }]), null);
  // right at the ceiling still parses
  const at = buildQuestionQname("a".repeat(200), zone);
  assert.ok(at);
  assert.equal(parseDnsiQname(at, [{ zone }])?.kind, "question");
});

test("parser rejects session parts wider than the documented chunk", () => {
  const zone = "dnsi.test";
  // 45 encoded bytes is the documented part size: accepted.
  assert.ok(parseDnsiQname(`sess.deadbeef.1.2.${"a".repeat(45)}.ask.${zone}`, [{ zone }]));
  // 46 is not, even though it is a legal DNS label.
  assert.equal(
    parseDnsiQname(`sess.deadbeef.1.2.${"a".repeat(46)}.ask.${zone}`, [{ zone }]),
    null,
  );
});

test("a question containing literal percent escapes survives the roundtrip", () => {
  const zone = "dnsi.test";
  // A literal '%2D' in the question must decode to '%2D', not to '-'.
  const q = "literal %2D and - dash 50%";
  const qname = buildQuestionQname(q, zone);
  assert.ok(qname);
  const parsed = parseDnsiQname(qname, [{ zone }]);
  assert.ok(parsed);
  if (parsed.kind === "question") assert.equal(parsed.question, q);
});

test("question results name the zone that was matched", () => {
  const parsed = parseDnsiQname("hi.ask.priv.dnsi.test", [
    { zone: "open.dnsi.test" },
    { zone: "priv.dnsi.test", token: "t0" },
  ]);
  assert.equal(parsed?.kind, "unauthorized"); // no token on a tokenized zone
  const withToken = parseDnsiQname("hi.t.t0.ask.priv.dnsi.test", [
    { zone: "open.dnsi.test" },
    { zone: "priv.dnsi.test", token: "t0" },
  ]);
  assert.ok(withToken && withToken.kind === "question");
  if (withToken.kind === "question") assert.equal(withToken.zone.zone, "priv.dnsi.test");
});

test("configured tokens match case-insensitively (names arrive lowercased)", () => {
  const zones = [{ zone: "dnsi.test", token: "s3cret" }];
  assert.equal(
    parseDnsiQname("hi.t.S3CRET.ask.dnsi.test", zones)?.kind, // as a client would send it
    "question",
  );
  assert.equal(parseDnsiQname("hi.t.wrong.ask.dnsi.test", zones)?.kind, "unauthorized");
});

test("decodeNameAt rejects names past the 253-octet ceiling", () => {
  // Five 63-byte labels = 319 octets: every label is legal on the wire, but
  // the name is longer than anything our own encoder would emit, so it is
  // rejected rather than handed to the backend as a 319-byte question.
  const long: Buffer[] = [];
  for (let i = 0; i < 5; i += 1) {
    long.push(Buffer.from([63]), Buffer.from("a".repeat(63), "latin1"));
  }
  long.push(Buffer.from([0]));
  const longPacket = Buffer.concat([Buffer.alloc(12), ...long, Buffer.alloc(4)]);
  assert.equal(decodeNameAt(longPacket, 12), null);

  // a name inside the ceiling still decodes
  const ok: Buffer[] = [];
  for (let i = 0; i < 4; i += 1) {
    ok.push(Buffer.from([60]), Buffer.from("a".repeat(60), "latin1"));
  }
  ok.push(Buffer.from([0]));
  const okPacket = Buffer.concat([Buffer.alloc(12), ...ok, Buffer.alloc(4)]);
  const decoded = decodeNameAt(okPacket, 12);
  assert.ok(decoded);
  assert.equal(decoded.name.split(".").length, 4);
});
