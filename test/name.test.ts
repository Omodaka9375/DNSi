import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildQuestionQname,
  decodeEncodedText,
  parseDnsiQname,
} from "../src/name.js";
import { chunkUtf8 } from "../src/wire.js";

test("question roundtrip preserves ascii case and punctuation", () => {
  const zone = "dnsi.test";
  const q = "What is DNSI? (really)";
  const qname = buildQuestionQname(q, zone);
  assert.ok(qname);
  const parsed = parseDnsiQname(qname, zone);
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
  const parsed = parseDnsiQname(qname, zone);
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
  const parsed = parseDnsiQname("tool.echo.hello%20world.ask." + zone, zone);
  assert.ok(parsed);
  if (parsed.kind === "tool") {
    assert.equal(parsed.tool, "echo");
    assert.equal(parsed.args, "hello world");
  } else {
    assert.fail("expected tool query");
  }
});

test("bare zone returns usage", () => {
  const parsed = parseDnsiQname("ask.dnsi.test", "dnsi.test");
  assert.ok(parsed);
  assert.equal(parsed.kind, "usage");
});

test("foreign names return null (NXDOMAIN)", () => {
  assert.equal(parseDnsiQname("example.com", "dnsi.test"), null);
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
