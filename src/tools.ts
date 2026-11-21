import { createHash, randomUUID } from "node:crypto";

export type ToolOutput = { text: string; canonical: boolean } | null;

/**
 * The agent tool surface: tool.<name>.<args>.ask.<zone>
 * Deterministic tools are canonical (TTL 3600, aggressively cached);
 * anything that must differ per call is dynamic (TTL 60, never cached).
 */
export function runTool(name: string, args: string): ToolOutput {
  switch (name) {
    case "time":
      return { text: new Date().toISOString(), canonical: false };
    case "echo":
      return { text: args.length > 0 ? args : "(no args)", canonical: true };
    case "uuid":
      // Not canonical: "a fresh value per call" is the whole point, and a
      // canonical result is cached under the fixed qname, which would hand
      // every client one shared UUID for the whole TTL. Same as "time".
      return { text: randomUUID(), canonical: false };
    case "hash":
      return { text: createHash("sha256").update(args, "utf8").digest("hex"), canonical: true };
    default:
      return null;
  }
}

export function listTools(): string {
  return "tools: time, echo, uuid, hash (tool.<name>.<args>.ask.<zone>)";
}
