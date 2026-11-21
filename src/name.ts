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
const MAX_QUESTION_BYTES = 200;
/** Long-question sessions: 32 chunks x 45 encoded bytes = ~1400 char budget. */
export const MAX_SESSION_QUESTION_BYTES = 1000;
const MAX_SESSION_CHUNK = 45;
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

export type DnsiQuery =
  | { kind: "question"; question: string }
  | { kind: "tool"; tool: string; args: string }
  | { kind: "session"; sid: string; n: number; total: number; chunk: string }
  | { kind: "usage" }
  | { kind: "unauthorized" };

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
    if (cfg.token !== undefined) {
      const tLabel = rest[rest.length - 2];
      const tokLabel = rest[rest.length - 1];
      if (tLabel !== "t" || tokLabel !== cfg.token) return { kind: "unauthorized" };
      rest = rest.slice(0, -2);
    }

    if (rest.length === 0) return { kind: "usage" };

    const head = rest[0];
    const second = rest[1];
    if (head === "sess" && second !== undefined && SID_RE.test(second) && rest.length >= 5) {
      const n = Number(rest[2]);
      const total = Number(rest[3]);
      if (!Number.isInteger(n) || !Number.isInteger(total)) return null;
      if (n < 1 || total < 1 || n > total || total > MAX_SESSION_PARTS) return null;
      const chunkLabels = rest.slice(4);
      if (chunkLabels.some((l) => l.length === 0)) return null;
      return {
        kind: "session",
        sid: second,
        n,
        total,
        chunk: decodeEncodedText(chunkLabels.join("")),
      };
    }
    if (head === "tool" && rest.length >= 2) {
      if (second === undefined || second.length === 0) return null;
      const argsLabels = rest.slice(2);
      return { kind: "tool", tool: second, args: decodeEncodedText(argsLabels.join("")) };
    }
    return { kind: "question", question: decodeEncodedText(rest.join("")) };
  }
  return null;
}
