#!/usr/bin/env node
import { selectBackend } from "./backend.js";
import { startDoh } from "./doh.js";
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
const stats = process.env.DNSI_STATS === "1";
const statsFile = process.env.DNSI_STATS_FILE;

// Optional DoH front (RFC 8484): DNSI_DOH_PORT, with optional TLS certs.
// Both fronts read the SAME PEM files; paths are env, contents are passed.
const certPath = process.env.DNSI_TLS_CERT;
const keyPath = process.env.DNSI_TLS_KEY;
let certPem: string | undefined;
let keyPem: string | undefined;
if (certPath && keyPath) {
  const { readFileSync } = await import("node:fs");
  certPem = readFileSync(certPath, "utf8");
  keyPem = readFileSync(keyPath, "utf8");
}

const server = await startServer({
  zones,
  udpPort: port,
  tcpPort: port,
  tcpOnly,
  backend,
  rateLimit,
  stats,
  statsFile,
  dotPort: Number(process.env.DNSI_DOT_PORT ?? 0) || undefined,
  tlsCert: certPem,
  tlsKey: keyPem,
});

// Optional DoH front (RFC 8484): DNSI_DOH_PORT, with optional TLS certs.
const dohPort = Number(process.env.DNSI_DOH_PORT ?? 0);
let dohPort_ = 0;
let dohServer: Awaited<ReturnType<typeof startDoh>> | null = null;
if (Number.isInteger(dohPort) && dohPort > 0) {
  dohServer = await startDoh(server.dnsi, {
    port: dohPort,
    tlsCert: certPem,
    tlsKey: keyPem,
  });
  dohPort_ = dohServer.port;
}

// No per-client logging. One startup line, nothing else.
console.log(
  `[dnsi] zones=${zones.map((z) => z.zone + (z.token ? "(token)" : "")).join(",")} ` +
    `backend=${backend.name} udp=${tcpOnly ? "off" : server.udpPort} tcp=${server.tcpPort} ` +
    `dot=${server.dotPort || "off"} doh=${dohPort_ || "off"} ` +
    `ratelimit=${rateLimit ? `${rateLimit.burst}/${rateLimit.refillPerSec}pps` : "off"} ` +
    `stats=${stats ? (statsFile ? `on(file ${statsFile})` : "on") : "off"}`,
);

process.on("SIGINT", () => {
  void (async () => {
    await dohServer?.stop();
    await server.stop();
    process.exit(0);
  })();
});
process.on("SIGTERM", () => {
  void (async () => {
    await dohServer?.stop();
    await server.stop();
    process.exit(0);
  })();
});
