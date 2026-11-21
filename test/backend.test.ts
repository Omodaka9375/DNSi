import { strict as assert } from "node:assert";
import { test } from "node:test";
import { OpenAICompatBackend } from "../src/backend.js";

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
