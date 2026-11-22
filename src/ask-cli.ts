#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import {
  buildQuestionQname,
  buildSessionQname,
  buildToolQname,
  chunkQuestion,
} from "./name.js";
import { queryTcp, queryUdp, aRecordsToText, RR_A, type DnsiResponse } from "./query.js";

const VERSION = "0.4.2";

const USAGE = [
  'usage: dnsi-ask "your question" [options]',
  '       dnsi-ask --tool <time|uuid|echo|hash> [args...] [options]',
  "",
  "options:",
  "  --local            query 127.0.0.1:5353 (zone dnsi.test) instead of dnsi.dev",
  "  --server <host>    nameserver address (or DNSI_HOST)",
  "  --port <port>      nameserver port (or DNSI_PORT)",
  "  --zone <zone>      DNSi zone suffix (or DNSI_ZONE)",
  "  --token <token>    per-zone token (or DNSI_TOKEN)",
  "  --tool <name>      invoke a built-in tool (time, uuid, echo, hash)",
  "  --tcp              send query over TCP",
  "  --a                request compact A-record answer (gethostbyname mode)",
  "  -h, --help         show this help",
  "  -v, --version      show version",
].join("\n");

const rawArgs = process.argv.slice(2);
if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

function takeOption(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const val = args[idx + 1];
  if (val === undefined || val.startsWith("--")) {
    console.error(`missing value for ${flag}\n\n${USAGE}`);
    process.exit(2);
  }
  args.splice(idx, 2);
  return val;
}

const token = takeOption(rawArgs, "--token") ?? process.env.DNSI_TOKEN;
const serverOpt = takeOption(rawArgs, "--server");
const portOpt = takeOption(rawArgs, "--port");
const zoneOpt = takeOption(rawArgs, "--zone");
const toolOpt = takeOption(rawArgs, "--tool");

const useTcp = rawArgs.includes("--tcp");
const useA = rawArgs.includes("--a");
const useLocal = rawArgs.includes("--local") || process.env.DNSI_LOCAL === "1";

const positional = rawArgs.filter((a) => a !== "--tcp" && a !== "--a" && a !== "--local");
const firstArg = positional[0];
if (firstArg !== undefined && firstArg.startsWith("-")) {
  console.error(`unknown option: ${firstArg}\n\n${USAGE}`);
  process.exit(2);
}

// Default target is the public instance (nameserver ns.dnsi.dev, port 53,
// names in the zone dnsi.dev: <question>.ask.dnsi.dev). Pass --local (or set
// DNSI_LOCAL=1) to ask a server on your own machine instead.
const localZone = "dnsi.test";
const publicZone = "dnsi.dev";
const publicServer = "ns.dnsi.dev";
const zone = (
  zoneOpt ??
  process.env.DNSI_ZONES ??
  process.env.DNSI_ZONE ??
  (useLocal ? localZone : publicZone)
)
  .split(",")[0]
  ?.split(":")[0]
  ?.trim() ?? (useLocal ? localZone : publicZone);
const port = Number(portOpt ?? process.env.DNSI_PORT ?? (useLocal ? 5353 : 53));
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid port: ${portOpt ?? process.env.DNSI_PORT}`);
  process.exit(2);
}
const host = serverOpt ?? process.env.DNSI_HOST ?? (useLocal ? "127.0.0.1" : publicServer);

const qtype = useA ? RR_A : undefined;

async function send(qname: string): Promise<DnsiResponse> {
  try {
    if (useTcp) return await queryTcp(port, qname, host, 10000, qtype);
    // A-mode answers often exceed classic 512-byte UDP: announce EDNS, and
    // retry over TCP if the server still says TC (what real resolvers do).
    const res = await queryUdp(port, qname, host, 5000, qtype, useA ? 1232 : undefined);
    if (!res.tc) return res;
    return await queryTcp(port, qname, host, 10000, qtype);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      !useLocal && host === publicServer
        ? " (tip: pass --local to query a local server on 127.0.0.1:5353)"
        : "";
    console.error(`DNS query to ${host}:${port} failed: ${msg}${hint}`);
    process.exit(1);
  }
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

// Tool invocation: either `--tool <name> [args...]` or `tool.<name> [args...]`
let toolName = toolOpt;
let toolArgsText = positional.join(" ");
if (!toolName && firstArg && /^tool\.[a-z0-9-]+$/i.test(firstArg)) {
  toolName = firstArg.slice(5);
  toolArgsText = positional.slice(1).join(" ");
}

if (toolName) {
  const qname = buildToolQname(toolName, toolArgsText, zone, token);
  if (!qname) {
    console.error("tool call cannot be encoded as a DNS name");
    process.exit(2);
  }
  print(await send(qname));
  process.exit(0);
}

const question = positional.join(" ");
if (question.length === 0) {
  console.error(USAGE);
  process.exit(2);
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
