#!/usr/bin/env node
import { selectBackend } from "./backend.js";
import { startServer } from "./server.js";
import type { ZoneConfig } from "./name.js";

function parseZones(env: NodeJS.ProcessEnv): ZoneConfig[] {
  const multi = env.DNSI_ZONES;
  if (typeof multi === "string" && multi.trim().length > 0) {
    return multi
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const idx = s.indexOf(":");
        if (idx === -1) return { zone: s };
        const zone = s.slice(0, idx).trim();
        const token = s.slice(idx + 1).trim();
        return token.length > 0 ? { zone, token } : { zone };
      });
  }
  const zone = env.DNSI_ZONE ?? "dnsi.test";
  const token = env.DNSI_TOKEN;
  return token && token.length > 0 ? [{ zone, token }] : [{ zone }];
}

const zones = parseZones(process.env);
const port = Number(process.env.DNSI_PORT ?? 5353);
const tcpOnly = process.env.DNSI_TCP_ONLY === "1";
const backend = selectBackend();

const server = await startServer({
  zones,
  udpPort: port,
  tcpPort: port,
  tcpOnly,
  backend,
});

// No per-client logging. One startup line, nothing else.
console.log(
  `[dnsi] zones=${zones.map((z) => z.zone + (z.token ? "(token)" : "")).join(",")} ` +
    `backend=${backend.name} udp=${tcpOnly ? "off" : server.udpPort} tcp=${server.tcpPort}`,
);

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void server.stop().then(() => process.exit(0));
});
