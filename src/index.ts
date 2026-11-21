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

/**
 * Per-client token bucket. Enabled by default: an unthrottled public
 * nameserver is the failure mode this project is explicitly designed
 * against. DNSI_RATE_BURST / DNSI_RATE_REFILL size it, and
 * DNSI_RATE_LIMIT=off turns it off.
 */
function parseRateLimit(env: NodeJS.ProcessEnv): { burst: number; refillPerSec: number } | null {
  if (env.DNSI_RATE_LIMIT === "off") return null;
  const burst = Number(env.DNSI_RATE_BURST ?? 20);
  const refillPerSec = Number(env.DNSI_RATE_REFILL ?? 1);
  if (!Number.isFinite(burst) || burst < 1 || !Number.isFinite(refillPerSec) || refillPerSec <= 0) {
    return { burst: 20, refillPerSec: 1 };
  }
  return { burst, refillPerSec };
}

const zones = parseZones(process.env);
const port = Number(process.env.DNSI_PORT ?? 5353);
const tcpOnly = process.env.DNSI_TCP_ONLY === "1";
const backend = selectBackend();
const rateLimit = parseRateLimit(process.env);

const server = await startServer({
  zones,
  udpPort: port,
  tcpPort: port,
  tcpOnly,
  backend,
  rateLimit,
});

// No per-client logging. One startup line, nothing else.
console.log(
  `[dnsi] zones=${zones.map((z) => z.zone + (z.token ? "(token)" : "")).join(",")} ` +
    `backend=${backend.name} udp=${tcpOnly ? "off" : server.udpPort} tcp=${server.tcpPort} ` +
    `ratelimit=${rateLimit ? `${rateLimit.burst}/${rateLimit.refillPerSec}pps` : "off"}`,
);

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void server.stop().then(() => process.exit(0));
});
