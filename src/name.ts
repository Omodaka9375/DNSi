/**
 * QNAME <-> question codec.
 *
 * Encoding rules (reversible):
 *   space            -> '-' (single byte)
 *   [a-z0-9]         -> literal
 *   everything else  -> '%' + two uppercase hex digits of the UTF-8 byte
 *
 * The encoded stream is packed greedily into labels of at most
 * MAX_LABEL_BYTES bytes; tokens are never split across labels.
 */

const MAX_LABEL_BYTES = 50;
/** Enforced by the server too (parseDnsiQname), not just by the builder. */
export const MAX_QUESTION_BYTES = 200;
/** Long-question sessions: 32 chunks x 45 encoded bytes = ~1400 char budget.
 * Enforced by the server too (sessionChunk), as a running total. */
export const MAX_SESSION_QUESTION_BYTES = 1000;
/** Encoded bytes per session part. Enforced by the server too. */
export const MAX_SESSION_CHUNK = 45;
const MAX_SESSION_PARTS = 32;
const SID_RE = /^[0-9a-f]{8}$/;

export type ZoneConfig = { zone: string; token?: string };

function questionToTokens(question: string): string[] {
  const bytes = Buffer.from(question, "utf8");
  const tokens: string[] = [];
  for (const b of bytes) {
    if (b === 0x20) {
      tokens.push("-");
    } else if ((b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39)) {
      tokens.push(String.fromCharCode(b));
    } else {
      tokens.push("%" + b.toString(16).toUpperCase().padStart(2, "0"));
    }
  }
  return tokens;
}

function packLabels(tokens: string[], max = MAX_LABEL_BYTES): string[] | null {
  const labels: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (t.length > max) return null;
    if (cur.length + t.length > max) {
      labels.push(cur);
      cur = t;
    } else {
      cur += t;
    }
  }
  if (cur.length > 0) labels.push(cur);
  return labels;
}

function fitQname(labels: string[]): string | null {
  const total = labels.reduce((n, l) => n + l.length + 1, 0) + 1;
  return total > 253 ? null : labels.join(".");
}

/** Build the full QNAME for a question, e.g. "what-is-dnsi.ask.dnsi.test". */
export function buildQuestionQname(
  question: string,
  zone: string,
  token?: string,
): string | null {
  if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) return null;
  const qLabels = packLabels(questionToTokens(question));
  if (!qLabels || qLabels.length === 0) return null;
  const suffix = token ? ["t", token, "ask", ...zone.split(".")] : ["ask", ...zone.split(".")];
  return fitQname([...qLabels, ...suffix]);
}

/**
 * Split a question into encoded chunks for session transport
 * (tokens are never split across chunks). Null when the question is
 * too long even for sessions.
 */
export function chunkQuestion(question: string, maxChunk = MAX_SESSION_CHUNK): string[] | null {
  if (Buffer.byteLength(question, "utf8") > MAX_SESSION_QUESTION_BYTES) return null;
  const tokens = questionToTokens(question);
  const chunks: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (cur.length + t.length > maxChunk) {
      chunks.push(cur);
      cur = t;
    } else {
      cur += t;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.length <= MAX_SESSION_PARTS ? chunks : null;
}

/** Build a session-part QNAME: sess.<sid>.<n>.<total>.<chunk>.t.<token>.ask.<zone> */
export function buildSessionQname(
  sid: string,
  n: number,
  total: number,
  chunkEncoded: string,
  zone: string,
  token?: string,
): string | null {
  const labels = ["sess", sid, String(n), String(total), chunkEncoded];
  if (token) labels.push("t", token);
  labels.push("ask", ...zone.split("."));
  return fitQname(labels);
}

/** Build a tool QNAME: tool.<name>[.<encoded-args>][.t.<token>].ask.<zone> */
export function buildToolQname(
  tool: string,
  args: string,
  zone: string,
  token?: string,
): string | null {
  const cleanTool = tool.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(cleanTool)) return null;
  if (Buffer.byteLength(args, "utf8") > MAX_QUESTION_BYTES) return null;
  const labels = ["tool", cleanTool];
  if (args.length > 0) {
    const argLabels = packLabels(questionToTokens(args));
    if (!argLabels) return null;
    labels.push(...argLabels);
  }
  if (token) labels.push("t", token);
  labels.push("ask", ...zone.split("."));
  return fitQname(labels);
}

const CHUNK_TOKEN_RE = /^(?:-|[a-zA-Z0-9]|%[0-9A-Fa-f]{2})*$/;

/**
 * Exact decoded byte count of an encoded string, computed without decoding
 * it. Decoding a single session part can be lossy (its last %XX token may be
 * one third of a UTF-8 character), so this is what the session budget uses.
 * Null when the string is not well-formed encoded text.
 */
export function encodedByteLength(encoded: string): number | null {
  if (!CHUNK_TOKEN_RE.test(encoded)) return null;
  let bytes = 0;
  for (let i = 0; i < encoded.length; i += 1) {
    bytes += 1;
    if (encoded[i] === "%") i += 2;
  }
  return bytes;
}

export function decodeEncodedText(encoded: string): string {
  const out: number[] = [];
  let i = 0;
  while (i < encoded.length) {
    const c = encoded[i];
    if (c === undefined) break;
    if (c === "-") {
      out.push(0x20);
      i += 1;
    } else if (c === "%") {
      const hex = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return "";
      out.push(parseInt(hex, 16));
      i += 3;
    } else {
      out.push(c.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(out).toString("utf8");
}

/** The matched ZoneConfig is carried on every result: on a multi-zone
 * server, generated CNAME targets and usage text must name the zone that
 * was actually queried, never zones[0]. */
export type DnsiQuery =
  | { kind: "question"; question: string; zone: ZoneConfig }
  | { kind: "tool"; tool: string; args: string; zone: ZoneConfig }
  | {
      kind: "session";
      sid: string;
      n: number;
      total: number;
      chunk: string;
      zone: ZoneConfig;
    }
  | { kind: "usage"; zone: ZoneConfig }
  | { kind: "unauthorized"; zone: ZoneConfig };

/**
 * Parse a QNAME against our zones. Returns null when the name belongs to
 * nobody (NXDOMAIN) and kind "unauthorized" when the zone requires a
 * token that the name does not carry.
 *
 * Patterns:
 *   <encoded question>.ask.<zone>
 *   <encoded question>.t.<token>.ask.<zone>
 *   tool.<name>.<args...>.ask.<zone>
 *   sess.<sid8hex>.<n>.<total>.<chunk>...[.t.<token>].ask.<zone>
 *   ask.<zone>                          -> usage help
 */
export function parseDnsiQname(qname: string, zones: ZoneConfig[]): DnsiQuery | null {
  const labels = qname.split(".");
  // longest suffix match wins ("a.b.c" before "b.c")
  const sorted = [...zones].sort((a, b) => b.zone.length - a.zone.length);
  for (const cfg of sorted) {
    const zoneLabels = cfg.zone.split(".");
    if (labels.length <= zoneLabels.length) continue;
    const tail = labels.slice(labels.length - zoneLabels.length).join(".");
    if (tail !== zoneLabels.join(".")) continue;

    let rest = labels.slice(0, labels.length - zoneLabels.length);
    if (rest[rest.length - 1] === "ask") rest = rest.slice(0, -1);

    // per-zone token: ...t.<token>.ask.<zone>
    // Names arrive lowercased (decodeNameAt folds case), so the configured
    // token is compared case-insensitively: an uppercase DNSI_TOKEN would
    // otherwise REFUSE every query with nothing to show why.
    if (cfg.token !== undefined) {
      const tLabel = rest[rest.length - 2];
      const tokLabel = rest[rest.length - 1];
      // Both sides lowercased: names arrive lowercased off the wire, and a
      // directly-supplied name may not be.
      if (
        tLabel !== "t" ||
        (tokLabel ?? "").toLowerCase() !== cfg.token.toLowerCase()
      ) {
        return { kind: "unauthorized", zone: cfg };
      }
      rest = rest.slice(0, -2);
    }

    if (rest.length === 0) return { kind: "usage", zone: cfg };

    const head = rest[0];
    const second = rest[1];
    if (head === "sess" && second !== undefined && SID_RE.test(second) && rest.length >= 5) {
      const n = Number(rest[2]);
      const total = Number(rest[3]);
      if (!Number.isInteger(n) || !Number.isInteger(total)) return null;
      if (n < 1 || total < 1 || n > total || total > MAX_SESSION_PARTS) return null;
      const chunkLabels = rest.slice(4);
      if (chunkLabels.some((l) => l.length === 0)) return null;
      // The part is returned STILL ENCODED on purpose. A %XX token can
      // straddle a part boundary (a 3-byte UTF-8 character is three %XX
      // tokens), so parts may only be decoded after they are joined.
      const encoded = chunkLabels.join("");
      // At most MAX_SESSION_CHUNK encoded bytes per part, which is what
      // chunkQuestion emits: enforced here too, so a hand-built client
      // cannot ship wider parts and inflate the session past its budget.
      if (encoded.length === 0 || encoded.length > MAX_SESSION_CHUNK) return null;
      if (encodedByteLength(encoded) === null) return null;
      return { kind: "session", sid: second, n, total, chunk: encoded, zone: cfg };
    }
    if (head === "tool" && rest.length >= 2) {
      if (second === undefined || second.length === 0) return null;
      const argsLabels = rest.slice(2);
      return {
        kind: "tool",
        tool: second,
        args: decodeEncodedText(argsLabels.join("")),
        zone: cfg,
      };
    }
    const question = decodeEncodedText(rest.join(""));
    // An empty question is a malformed name, and a question past the
    // documented ceiling is not one we serve: both are NXDOMAIN, never a
    // backend call carrying unbounded text.
    if (question.length === 0) return null;
    if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) return null;
    return { kind: "question", question, zone: cfg };
  }
  return null;
}
