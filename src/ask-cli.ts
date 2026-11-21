import { randomBytes } from "node:crypto";
import { buildQuestionQname, buildSessionQname, chunkQuestion } from "./name.js";
import { queryTcp, queryUdp, aRecordsToText, RR_A, type DnsiResponse } from "./query.js";

const rawArgs = process.argv.slice(2);
const useTcp = rawArgs.includes("--tcp");
const useA = rawArgs.includes("--a");
let token = process.env.DNSI_TOKEN;
const tokenIdx = rawArgs.indexOf("--token");
if (tokenIdx !== -1 && rawArgs[tokenIdx + 1] !== undefined) {
  token = rawArgs[tokenIdx + 1];
  rawArgs.splice(tokenIdx, 2);
}
const args = rawArgs.filter((a) => a !== "--tcp" && a !== "--a");
const question = args.join(" ");
if (question.length === 0) {
  console.error('usage: pnpm ask -- "your question" [--tcp] [--a] [--token <t>]');
  process.exit(2);
}

const zones = (process.env.DNSI_ZONES ?? process.env.DNSI_ZONE ?? "dnsi.test")
  .split(",")[0]
  ?.split(":")[0] ?? "dnsi.test";
const zone = zones.trim();
const port = Number(process.env.DNSI_PORT ?? 5353);
const host = process.env.DNSI_HOST ?? "127.0.0.1";

async function send(qname: string): Promise<DnsiResponse> {
  return useTcp
    ? queryTcp(port, qname, host, 10000, useA ? RR_A : undefined)
    : queryUdp(port, qname, host, 5000, useA ? RR_A : undefined);
}

function print(res: DnsiResponse): void {
  if (res.rcode !== 0) {
    console.error(`DNS error rcode=${res.rcode}${res.rcode === 5 ? " (REFUSED: bad token)" : ""}`);
    process.exit(1);
  }
  if (useA) {
    console.log(aRecordsToText(res.a));
    return;
  }
  console.log(res.txt);
  if (res.cnames.length > 0) {
    console.log("\nrelated:");
    for (const c of res.cnames) console.log(`  dig TXT ${c}`);
  }
}

const longQuestion = Buffer.byteLength(question, "utf8") > 200;
if (!longQuestion) {
  const qname = buildQuestionQname(question, zone, token);
  if (!qname) {
    console.error("question cannot be encoded as a DNS name");
    process.exit(2);
  }
  print(await send(qname));
} else {
  // Session mode: ship the question in chunks; the final chunk returns the
  // answer. The server assembles part order 1..total.
  const chunks = chunkQuestion(question);
  if (!chunks) {
    console.error("question too long (max ~1000 bytes via session mode)");
    process.exit(2);
  }
  const sid = randomBytes(4).toString("hex");
  const total = chunks.length;
  for (let i = 0; i < total - 1; i += 1) {
    const qname = buildSessionQname(sid, i + 1, total, chunks[i] ?? "", zone, token);
    if (!qname) {
      console.error("session chunk cannot be encoded (token too long?)");
      process.exit(2);
    }
    const res = await send(qname);
    if (res.rcode !== 0) {
      console.error(`DNS error rcode=${res.rcode} while uploading chunk ${i + 1}/${total}`);
      process.exit(1);
    }
  }
  const finalQname = buildSessionQname(sid, total, total, chunks[total - 1] ?? "", zone, token);
  if (!finalQname) {
    console.error("session chunk cannot be encoded");
    process.exit(2);
  }
  print(await send(finalQname));
}
