/** Answer backends. The echo backend runs with zero configuration; the
 * OpenAI-compatible backend is enabled via env (works with OpenAI, Groq,
 * OpenRouter, Ollama, anything speaking /chat/completions). */

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
      text: `DNSI (echo backend): ${question}`,
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
  const base = env.DNSI_LLM_BASE_URL;
  const key = env.DNSI_LLM_API_KEY;
  if (typeof base === "string" && base.length > 0 && typeof key === "string" && key.length > 0) {
    return new OpenAICompatBackend(base, key, env.DNSI_LLM_MODEL ?? "gpt-4o-mini");
  }
  return new EchoBackend();
}
