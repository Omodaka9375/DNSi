import { selectBackend } from "./backend.js";
import { startServer } from "./server.js";

const zone = process.env.DNSI_ZONE ?? "dnsi.test";
const port = Number(process.env.DNSI_PORT ?? 5353);
const tcpOnly = process.env.DNSI_TCP_ONLY === "1";
const backend = selectBackend();

const server = await startServer({
  zone,
  udpPort: port,
  tcpPort: port,
  tcpOnly,
  backend,
});

// No per-client logging. One startup line, nothing else.
console.log(
  `[dnsi] zone=${zone} backend=${backend.name} udp=${tcpOnly ? "off" : server.udpPort} tcp=${server.tcpPort}`,
);

process.on("SIGINT", () => {
  void server.stop().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void server.stop().then(() => process.exit(0));
});
