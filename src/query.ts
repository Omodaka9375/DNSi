import dgram from "node:dgram";
import net from "node:net";
import { encodeName, parseResponse, RR_TXT, CLASS_IN } from "./wire.js";

export type DnsiResponse = {
  rcode: number;
  txt: string;
  cnames: string[];
};

/** Build a DNS query packet for one name (TXT, IN). */
export function buildQuery(qname: string, id?: number): Buffer | null {
  const name = encodeName(qname);
  if (!name) return null;
  const header = Buffer.alloc(12);
  const qid = id ?? Math.floor(Math.random() * 0xffff);
  header.writeUInt16BE(qid & 0xffff, 0);
  header.writeUInt16BE(0x0100, 2); // RD
  header.writeUInt16BE(1, 4); // QDCOUNT
  return Buffer.concat([header, name, Buffer.from([0, RR_TXT, 0, CLASS_IN])]);
}

export async function queryUdp(
  port: number,
  qname: string,
  host = "127.0.0.1",
  timeoutMs = 5000,
): Promise<DnsiResponse> {
  const query = buildQuery(qname);
  if (!query) throw new Error(`cannot encode qname: ${qname}`);
  const socket = dgram.createSocket("udp4");
  try {
    return await new Promise<DnsiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`timeout querying ${qname}`));
      }, timeoutMs);
      socket.on("message", (msg) => {
        clearTimeout(timer);
        socket.close();
        const parsed = parseResponse(msg);
        if (!parsed) {
          reject(new Error("unparseable response"));
          return;
        }
        resolve({ rcode: parsed.rcode, txt: parsed.txt.join(""), cnames: parsed.cnames });
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      socket.send(query, port, host);
    });
  } finally {
    try {
      socket.close();
    } catch {
      // already closed
    }
  }
}

export async function queryTcp(
  port: number,
  qname: string,
  host = "127.0.0.1",
  timeoutMs = 10000,
): Promise<DnsiResponse> {
  const query = buildQuery(qname);
  if (!query) throw new Error(`cannot encode qname: ${qname}`);
  const framed = Buffer.alloc(2 + query.length);
  framed.writeUInt16BE(query.length, 0);
  query.copy(framed, 2);
  const socket = net.createConnection({ host, port });
  try {
    return await new Promise<DnsiResponse>((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`timeout querying ${qname}`));
      }, timeoutMs);
      socket.on("connect", () => socket.write(framed));
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;
        clearTimeout(timer);
        const msg = buf.subarray(2, 2 + len);
        socket.destroy();
        const parsed = parseResponse(msg);
        if (!parsed) {
          reject(new Error("unparseable response"));
          return;
        }
        resolve({ rcode: parsed.rcode, txt: parsed.txt.join(""), cnames: parsed.cnames });
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    socket.destroy();
  }
}

