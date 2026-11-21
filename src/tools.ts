import { createHash, randomUUID } from "node:crypto";

export type ToolOutput = { text: string; canonical: boolean } | null;

/**
 * The agent tool surface: tool.<name>.<args>.ask.<zone>
 * Deterministic tools are canonical (TTL 3600, aggressively cached);
 * time is dynamic (TTL 60).
 */
export function runTool(name: string, args: string): ToolOutput {
  switch (name) {
    case "time":
      return { text: new Date().toISOString(), canonical: false };
    case "echo":
      return { text: args.length > 0 ? args : "(no args)", canonical: true };
    case "uuid":
      return { text: randomUUID(), canonical: true };
    case "hash":
      return { text: createHash("sha256").update(args, "utf8").digest("hex"), canonical: true };
    default:
      return null;
  }
}

export function listTools(): string {
  return "tools: time, echo, uuid, hash (tool.<name>.<args>.ask.<zone>)";
}
