/**
 * Minimal DNS wire format: query parsing and response encoding.
 * We own the wire code on purpose: DNSI is a protocol experiment and needs
 * exact control over TXT chunking and CNAME answers. No name compression is
 * emitted (legal and simpler); compression pointers are followed when reading.
 */

export const RR_A = 1;
export const RR_CNAME = 5;
export const RR_TXT = 16;
export const CLASS_IN = 1;

/** Flag in the response header: answer too large for UDP, retry over TCP. */
export const FLAGS_TC = 0x0200;

/** Classic UDP DNS payload limit (no EDNS0). */
export const UDP_MAX = 512;

export const RCODE = {
  NOERROR: 0,
  SERVFAIL: 2,
  NXDOMAIN: 3,
} as const;

export type QueryInfo = {
  id: number;
  qname: string;
  qtype: number;
  qclass: number;
};

export type AnswerRecord =
  | { type: "TXT"; strings: Buffer[]; ttl: number }
  | { type: "CNAME"; target: string; ttl: number }
  | { type: "A"; addresses: Buffer[]; ttl: number };

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff, 0);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

export function encodeName(name: string): Buffer | null {
  if (name.length === 0 || name.length > 253) return null;
  const parts: Buffer[] = [];
  for (const label of name.split(".")) {
    const byteLen = Buffer.byteLength(label, "latin1");
    if (label.length === 0 || byteLen > 63) return null;
    parts.push(Buffer.from([byteLen]));
    parts.push(Buffer.from(label, "latin1"));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export type DecodedName = { name: string; next: number };

/** Decode a name starting at `off`, following compression pointers. */
export function decodeNameAt(buf: Buffer, off: number): DecodedName | null {
  const labels: string[] = [];
  let o = off;
  let next = -1;
  for (let guard = 0; guard < 128; guard += 1) {
    const len = buf[o];
    if (len === undefined) return null;
    if (len === 0) {
      return { name: labels.join("."), next: next === -1 ? o + 1 : next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (next === -1) next = o + 2;
      const low = buf[o + 1];
      if (low === undefined) return null;
      const ptr = ((len & 0x3f) << 8) | low;
      o = ptr;
      continue;
    }
    if (len > 63) return null;
    labels.push(buf.subarray(o + 1, o + 1 + len).toString("latin1").toLowerCase());
    o += 1 + len;
  }
  return null;
}

/** Parse a standard query (we only need id + first question). */
export function parseQuery(buf: Buffer): QueryInfo | null {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return null; // a response, not a query
  const qdcount = buf.readUInt16BE(4);
  if (qdcount < 1) return null;
  const name = decodeNameAt(buf, 12);
  if (!name) return null;
  let off = name.next;
  if (off + 4 > buf.length) return null;
  const qtype = buf.readUInt16BE(off);
  const qclass = buf.readUInt16BE(off + 2);
  const qname = name.name.replace(/\.$/, "");
  return { id, qname, qtype, qclass };
}

export function encodeResponse(
  id: number,
  qname: string,
  qtype: number,
  qclass: number,
  answers: AnswerRecord[],
  rcode: number,
  tc = false,
): Buffer {
  // A truncated response carries no answers; the TC bit tells the client
  // to retry over TCP.
  const emitted = tc ? [] : answers;
  // ANCOUNT counts wire RRs: one A answer expands to one RR per address.
  const rrCount = emitted.reduce((n, a) => n + (a.type === "A" ? a.addresses.length : 1), 0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id & 0xffff, 0);
  header.writeUInt16BE(0x8000 | 0x0100 | 0x0080 | (tc ? FLAGS_TC : 0) | (rcode & 0x0f), 2);
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(rrCount, 6); // ANCOUNT

  const encodedQname = encodeName(qname);
  const qsecName = encodedQname ?? Buffer.from([0]);
  const qsec = Buffer.concat([qsecName, u16(qtype), u16(qclass)]);

  const answerSections: Buffer[] = [];
  // Owner name = compression pointer to the question at offset 12. Without
  // this, every A-mode record repeats the full QNAME and responses balloon
  // past the 512-byte UDP limit.
  const ownerPtr = Buffer.from([0xc0, 0x0c]);
  for (const a of emitted) {
    const owner = ownerPtr;
    if (a.type === "TXT") {
      const strings: Buffer[] = [];
      for (const s of a.strings) {
        const clipped = s.subarray(0, 255);
        strings.push(Buffer.from([clipped.length]), clipped);
      }
      if (strings.length === 0) strings.push(Buffer.from([0]));
      const rdata = Buffer.concat(strings);
      answerSections.push(
        Buffer.concat([owner, u16(RR_TXT), u16(CLASS_IN), u32(a.ttl), u16(rdata.length), rdata]),
      );
    } else if (a.type === "A") {
      for (const addr of a.addresses) {
        answerSections.push(
          Buffer.concat([owner, u16(RR_A), u16(CLASS_IN), u32(a.ttl), u16(4), addr.subarray(0, 4)]),
        );
      }
    } else {
      const rdata = encodeName(a.target) ?? Buffer.from([0]);
      answerSections.push(
        Buffer.concat([owner, u16(RR_CNAME), u16(CLASS_IN), u32(a.ttl), u16(rdata.length), rdata]),
      );
    }
  }

  return Buffer.concat([header, qsec, ...answerSections]);
}

/**
 * Split text into <=255 byte character-strings on UTF-8 code point
 * boundaries (a naive byte split would corrupt multibyte characters).
 */
export function chunkUtf8(text: string, max = 255): Buffer[] {
  const chunks: Buffer[] = [];
  let cur: number[] = [];
  let curBytes = 0;
  for (const ch of text) {
    const b = Buffer.from(ch, "utf8");
    if (curBytes + b.length > max) {
      chunks.push(Buffer.from(cur));
      cur = [];
      curBytes = 0;
    }
    for (const byte of b) cur.push(byte);
    curBytes += b.length;
  }
  if (cur.length > 0) chunks.push(Buffer.from(cur));
  return chunks;
}

/** Parse a response produced by this server (for the test client). */
export type ParsedResponse = {
  id: number;
  rcode: number;
  tc: boolean;
  txt: string[];
  cnames: string[];
  a: string[];
};

export function parseResponse(buf: Buffer): ParsedResponse | null {
  if (buf.length < 12) return null;
  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const rcode = flags & 0x0f;
  const tc = (flags & FLAGS_TC) !== 0;
  const ancount = buf.readUInt16BE(6);
  const qdcount = buf.readUInt16BE(4);
  let off = 12;
  for (let i = 0; i < qdcount; i += 1) {
    const n = decodeNameAt(buf, off);
    if (!n) return null;
    off = n.next + 4;
  }
  const txt: string[] = [];
  const cnames: string[] = [];
  const a: string[] = [];
  for (let i = 0; i < ancount; i += 1) {
    const n = decodeNameAt(buf, off);
    if (!n) return null;
    off = n.next;
    if (off + 10 > buf.length) return null;
    const type = buf.readUInt16BE(off);
    off += 8; // type + class + ttl
    const rdlen = buf.readUInt16BE(off);
    off += 2;
    const rdata = buf.subarray(off, off + rdlen);
    off += rdlen;
    if (type === RR_TXT) {
      let o = 0;
      while (o < rdata.length) {
        const slen = rdata[o];
        if (slen === undefined) return null;
        txt.push(rdata.subarray(o + 1, o + 1 + slen).toString("utf8"));
        o += 1 + slen;
      }
    } else if (type === RR_CNAME) {
      const target = decodeNameAt(rdata, 0);
      if (target) cnames.push(target.name);
    } else if (type === RR_A && rdlen === 4) {
      a.push(rdata.join("."));
    }
  }
  return { id, rcode, tc, txt, cnames, a };
}
