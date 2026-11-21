import { EchoBackend } from "../src/backend.js";
import { buildQuestionQname } from "../src/name.js";
import { startServer } from "../src/server.js";
import { queryTcp, queryUdp } from "../src/query.js";

const ZONE = "dnsi.test";
const server = await startServer({ zone: ZONE, udpPort: 0, tcpPort: 0, backend: new EchoBackend() });

async function show(label: string, fn: () => Promise<{ rcode: number; txt: string; cnames: string[] }>) {
  console.log(`### ${label}`);
  const r = await fn();
  if (r.rcode !== 0) {
    console.log(`;; rcode=${r.rcode}`);
  } else {
    console.log(`;; ANSWER (TXT, ${r.txt.length} bytes):`);
    console.log(r.txt);
    if (r.cnames.length > 0) {
      console.log(";; ANSWER (CNAME, related questions):");
      for (const c of r.cnames) console.log(`  ${c}`);
    }
  }
  console.log();
}

await show('dig +short TXT "What is DNSI?" @server -p 5353',
  () => queryUdp(server.udpPort, buildQuestionQname("What is DNSI?", ZONE) ?? ""));
await show("dig +short TXT tool.time.ask.dnsi.test",
  () => queryUdp(server.udpPort, `tool.time.ask.${ZONE}`));
await show("dig +short TXT tool.hash.hello.ask.dnsi.test",
  () => queryTcp(server.tcpPort, `tool.hash.hello.ask.${ZONE}`));
await show("dig +short TXT ask.dnsi.test   (usage)",
  () => queryUdp(server.udpPort, `ask.${ZONE}`));
await show("dig +short TXT example.com   (not our zone)",
  () => queryUdp(server.udpPort, "example.com"));

await server.stop();
