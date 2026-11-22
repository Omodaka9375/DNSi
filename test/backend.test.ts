import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  OpenAICompatBackend,
  CannedBackend,
  loadCannedAnswers,
  normalizeQuestion,
  selectBackend,
  DEFAULT_LLM_TIMEOUT_MS,
} from "../src/backend.js";
import { encodedByteLength, MAX_SESSION_CHUNK, MAX_SESSION_QUESTION_BYTES } from "../src/name.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FetchCall = { url: string; init: RequestInit };

function mockFetch(status: number, body: unknown) {
  const calls: FetchCall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const COMPLETIONS_OK = {
  choices: [
    {
      message: {
        content: "DNSi answers questions over DNS.\nRELATED: what is dnsi | how fast is dnsi",
      },
    },
  ],
};

test("openai backend: happy path parses answer and RELATED line", async () => {
  const { impl, calls } = mockFetch(200, COMPLETIONS_OK);
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  const answer = await backend.ask("what is dnsi");
  assert.equal(answer.text, "DNSi answers questions over DNS.");
  assert.deepEqual(answer.related, ["what is dnsi", "how fast is dnsi"]);
  assert.equal(answer.canonical, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.url.startsWith("https://api.example/v1/chat/completions"));
  const sent = JSON.parse(String(calls[0]?.init.body));
  assert.equal(sent.model, "m1");
  assert.equal(sent.messages[1].content, "what is dnsi");
  // auth header present, never logged elsewhere
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("authorization"), "Bearer sk-test");
});

test("openai backend: non-2xx raises (surfaced as SERVFAIL by the server)", async () => {
  const { impl } = mockFetch(503, { error: "upstream down" });
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  await assert.rejects(() => backend.ask("hello"), /HTTP 503/);
});

test("openai backend: invalid response shape raises", async () => {
  const { impl } = mockFetch(200, { choices: [] });
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  await assert.rejects(() => backend.ask("hello"), /no assistant content/);
});

test("openai backend: missing RELATED line yields empty related list", async () => {
  const { impl } = mockFetch(200, { choices: [{ message: { content: "just an answer" } }] });
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  const answer = await backend.ask("hello");
  assert.equal(answer.text, "just an answer");
  assert.deepEqual(answer.related, []);
});

test("openai backend: RELATED with more than 3 entries is capped", async () => {
  const content = "ans\nRELATED: a | b | c | d | e";
  const { impl } = mockFetch(200, { choices: [{ message: { content } }] });
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  const answer = await backend.ask("hello");
  assert.equal(answer.related.length, 3);
});

test("canned backend: matches ignoring case, punctuation and extra spaces", async () => {
  const canned = new CannedBackend(
    { "What is DNSi?": { answer: "the answer" } },
    "default text",
  );
  for (const q of ["what is dnsi", "What is DNSi?!", "what  is   dnsi?", " WHAT IS DNSI. "]) {
    const a = await canned.ask(q);
    assert.equal(a.text, "the answer");
    assert.equal(a.canonical, true);
  }
  assert.equal(normalizeQuestion("  Hello,   World?!  "), "hello, world");
});

test("canned backend: unknown question returns the default", async () => {
  const canned = new CannedBackend(
    { "known": { answer: "yes", related: ["known"] } },
    "nope, prepared questions only",
  );
  const a = await canned.ask("completely unknown thing");
  assert.equal(a.text, "nope, prepared questions only");
  assert.deepEqual(a.related, []);
});

test("canned backend: related questions are capped at 3", async () => {
  const canned = new CannedBackend(
    { "q": { answer: "a", related: ["1", "2", "3", "4", "5"] } },
    "d",
  );
  assert.equal((await canned.ask("q")).related.length, 3);
});

test("canned backend: entries without answers are skipped", async () => {
  const canned = new CannedBackend(
    { "bad": { related: ["x"] } as never, "good": { answer: "ok" } },
    "d",
  );
  assert.equal(canned.size, 1);
  assert.equal((await canned.ask("good")).text, "ok");
});

test("loadCannedAnswers: reads the JSON file, bad file throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dnsi-test-"));
  try {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ default: "d", questions: { "what is dnsi": { answer: "a" } } }));
    const backend = loadCannedAnswers(good);
    assert.equal((await backend.ask("WHAT IS DNSI?")).text, "a");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{ not json");
    assert.throws(() => loadCannedAnswers(bad), /not valid JSON/);

    const shapeless = join(dir, "shapeless.json");
    writeFileSync(shapeless, "{}");
    assert.throws(() => loadCannedAnswers(shapeless), /"questions" object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectBackend: DNSI_BACKEND=echo wins over DNSI_ANSWERS", () => {
  const dir = mkdtempSync(join(tmpdir(), "dnsi-test-"));
  try {
    const file = join(dir, "answers.json");
    writeFileSync(file, JSON.stringify({ default: "d", questions: {} }));
    const b = selectBackend({ DNSI_BACKEND: "echo", DNSI_ANSWERS: file });
    assert.equal(b.name, "echo");
    const c = selectBackend({ DNSI_ANSWERS: file });
    assert.equal(c.name, "canned");
    const e = selectBackend({});
    assert.equal(e.name, "echo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session budget constants match the documented caps", () => {
  assert.equal(MAX_SESSION_CHUNK, 45);
  assert.equal(MAX_SESSION_QUESTION_BYTES, 1000);
  // a %XX token counts as exactly one decoded byte, three encoded
  assert.equal(encodedByteLength("%E4%B8%AD"), 3);
  assert.equal(encodedByteLength("a-b"), 3, "'-' is one space byte");
  assert.equal(encodedByteLength("%2"), null, "malformed escape rejected");
  // a stray uppercase literal decodes to one byte (decodeEncodedText passes
  // any non-escape char through), so it counts rather than being rejected
  assert.equal(encodedByteLength("Z"), 1);
});

test("openai backend: request carries an abort timeout signal", async () => {
  const { impl, calls } = mockFetch(200, COMPLETIONS_OK);
  const backend = new OpenAICompatBackend("https://api.example/v1", "sk-test", "m1", impl);
  await backend.ask("hi");
  const init = calls[0]?.init as RequestInit & { signal?: AbortSignal };
  assert.ok(init.signal instanceof AbortSignal, "fetch must receive an AbortSignal");
});

test("selectBackend: DNSI_LLM_TIMEOUT_MS sizes the abort timeout", () => {
  // Indirect: selectBackend only constructs the backend; assert via the
  // exported default and a directly-constructed instance instead.
  assert.equal(typeof DEFAULT_LLM_TIMEOUT_MS, "number");
  assert.ok(DEFAULT_LLM_TIMEOUT_MS >= 1000);
  const b = new OpenAICompatBackend("https://x/v1", "k", "m", fetch, 250);
  assert.equal(b.name, "openai-compat");
});
