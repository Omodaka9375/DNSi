import { buildQuestionQname } from "./name.js";
import { queryTcp, queryUdp } from "./query.js";

const args = process.argv.slice(2).filter((a) => a !== "--tcp");
const question = args.join(" ");
if (question.length === 0) {
  console.error('usage: pnpm ask -- "your question" [--tcp]');
  process.exit(2);
}

const zone = process.env.DNSI_ZONE ?? "dnsi.test";
const port = Number(process.env.DNSI_PORT ?? 5353);
const host = process.env.DNSI_HOST ?? "127.0.0.1";

const qname = buildQuestionQname(question, zone);
if (!qname) {
  console.error("question too long to encode as a DNS name (max ~200 bytes)");
  process.exit(2);
}

const res = process.argv.includes("--tcp")
  ? await queryTcp(port, qname, host)
  : await queryUdp(port, qname, host);

if (res.rcode !== 0) {
  console.error(`DNS error rcode=${res.rcode}`);
  process.exit(1);
}

console.log(res.txt);
if (res.cnames.length > 0) {
  console.log("\nrelated:");
  for (const c of res.cnames) console.log(`  dig TXT ${c}`);
}
