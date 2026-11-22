/** Answer backends. The echo backend runs with zero configuration; the
 * OpenAI-compatible backend is enabled via env (works with OpenAI, Groq,
 * OpenRouter, Ollama, anything speaking /chat/completions). The canned
 * backend serves pre-prepared answers from a JSON file: a demo server
 * about a fixed topic with no AI and no API key at all. */

import { readFileSync } from "node:fs";

export type BackendAnswer = {
  text: string;
  related: string[];
  canonical: boolean;
};

export interface Backend {
  readonly name: string;
  ask(question: string): Promise<BackendAnswer>;
}

export const MAX_RELATED = 3;

export class EchoBackend implements Backend {
  readonly name = "echo";

  async ask(question: string): Promise<BackendAnswer> {
    return {
      text: `DNSi (echo backend): ${question}`,
      related: ["what is dnsi", "list tools"],
      canonical: false,
    };
  }
}

const SYSTEM_PROMPT = [
  "You answer queries delivered over DNS TXT records.",
  "Keep the answer under 600 characters, plain text, no markdown.",
  "After the answer, on its own last line, write RELATED: followed by 2 or 3",
  "short follow-up questions separated by | (no numbering). These become",
  "CNAME records pointing at related questions in the knowledge graph.",
].join(" ");

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function extractAssistantContent(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const choices = data.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!isRecord(first)) return null;
  const message = first.message;
  if (!isRecord(message)) return null;
  const content = message.content;
  return typeof content === "string" ? content : null;
}

function splitRelated(content: string): { answer: string; related: string[] } {
  const lines = content.split("\n");
  let related: string[] = [];
  const kept: string[] = [];
  for (const line of lines) {
    const m = /^RELATED:\s*(.+)$/i.exec(line.trim());
    if (m && m[1] !== undefined) {
      related = m[1]
        .split("|")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, MAX_RELATED);
    } else {
      kept.push(line);
    }
  }
  return { answer: kept.join("\n").trim(), related };
}

export class OpenAICompatBackend implements Backend {
  readonly name = "openai-compat";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ask(question: string): Promise<BackendAnswer> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: question },
        ],
        max_tokens: 500,
      }),
    });
    if (!res.ok) throw new Error(`LLM request failed: HTTP ${res.status}`);
    const data: unknown = await res.json();
    const content = extractAssistantContent(data);
    if (content === null) throw new Error("LLM response had no assistant content");
    const { answer, related } = splitRelated(content);
    return { text: answer, related, canonical: false };
  }
}

export function selectBackend(env: NodeJS.ProcessEnv = process.env): Backend {
  if (env.DNSI_BACKEND === "echo") return new EchoBackend();
  const answers = env.DNSI_ANSWERS;
  if (typeof answers === "string" && answers.length > 0) {
    return loadCannedAnswers(answers);
  }
  const base = env.DNSI_LLM_BASE_URL;
  const key = env.DNSI_LLM_API_KEY;
  if (typeof base === "string" && base.length > 0 && typeof key === "string" && key.length > 0) {
    return new OpenAICompatBackend(base, key, env.DNSI_LLM_MODEL ?? "gpt-4o-mini");
  }
  return new EchoBackend();
}

/** Case, punctuation and whitespace insensitive matching for canned Qs. */
export function normalizeQuestion(q: string): string {
  return q.trim().replace(/[?.!]+$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export type CannedEntry = { answer: string; related?: string[] };

export class CannedBackend implements Backend {
  readonly name = "canned";
  private readonly map: Map<string, CannedEntry>;
  private readonly fallback: string;

  constructor(entries: Record<string, CannedEntry>, fallback: string) {
    this.map = new Map();
    for (const [k, v] of Object.entries(entries)) {
      if (isRecord(v) && typeof v.answer === "string" && v.answer.length > 0) {
        // related is normalized to a string[] here so a malformed answers
        // file degrades to "no related questions" instead of throwing at
        // answer time, outside the backend error handling.
        const related = Array.isArray(v.related)
          ? v.related.filter((s): s is string => typeof s === "string")
          : [];
        this.map.set(normalizeQuestion(k), { answer: v.answer, related });
      }
    }
    this.fallback = fallback;
  }

  get size(): number {
    return this.map.size;
  }

  async ask(question: string): Promise<BackendAnswer> {
    const hit = this.map.get(normalizeQuestion(question));
    if (hit) {
      return {
        text: hit.answer,
        related: (hit.related ?? []).slice(0, MAX_RELATED),
        canonical: true,
      };
    }
    return { text: this.fallback, related: [], canonical: true };
  }
}

function parseCannedFile(raw: string): { questions: Record<string, CannedEntry>; fallback: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`canned answers file is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(data)) throw new Error("canned answers file must be an object");
  const qs = data.questions;
  if (!isRecord(qs)) throw new Error('canned answers file needs a "questions" object');
  const fallback =
    typeof data.default === "string" && data.default.length > 0
      ? data.default
      : "This DNSi demo answers prepared questions only (no AI). Try: what is dnsi";
  return { questions: qs as Record<string, CannedEntry>, fallback };
}

export function loadCannedAnswers(path: string): CannedBackend {
  const { questions, fallback } = parseCannedFile(readFileSync(path, "utf8"));
  return new CannedBackend(questions, fallback);
}
