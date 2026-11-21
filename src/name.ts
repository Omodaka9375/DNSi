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

/** Build the full QNAME for a question, e.g. "what-is-dnsi.ask.dnsi.test". */
export function buildQuestionQname(question: string, zone: string): string | null {
  if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) return null;
  const qLabels = packLabels(questionToTokens(question));
  if (!qLabels || qLabels.length === 0) return null;
  const suffix = ["ask", ...zone.split(".")];
  const totalBytes =
    qLabels.reduce((n, l) => n + l.length + 1, 0) +
    suffix.reduce((n, l) => n + l.length + 1, 0) +
    1;
  if (totalBytes > 253) return null;
  return [...qLabels, ...suffix].join(".");
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
  | { kind: "usage" };

/**
 * Parse a QNAME against our zone. Returns null when the name is not
 * delegated to us. Patterns:
 *   <encoded question>.ask.<zone>
 *   tool.<name>.<args...>.ask.<zone>
 *   ask.<zone>                          -> usage help
 */
export function parseDnsiQname(qname: string, zone: string): DnsiQuery | null {
  const labels = qname.split(".");
  const zoneLabels = zone.split(".");
  if (labels.length <= zoneLabels.length) return null;
  const tail = labels.slice(labels.length - zoneLabels.length);
  if (tail.join(".") !== zoneLabels.join(".")) return null;
  let rest = labels.slice(0, labels.length - zoneLabels.length);
  if (rest[rest.length - 1] === "ask") rest = rest.slice(0, -1);
  if (rest.length === 0) return { kind: "usage" };
  const head = rest[0];
  if (head === "tool" && rest.length >= 2) {
    const tool = rest[1];
    if (tool === undefined || tool.length === 0) return null;
    const argsLabels = rest.slice(2);
    return { kind: "tool", tool, args: decodeEncodedText(argsLabels.join("")) };
  }
  return { kind: "question", question: decodeEncodedText(rest.join("")) };
}
