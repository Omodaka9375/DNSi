# Running DNSI

## Local

```bash
pnpm install
pnpm start            # echo backend, UDP+TCP on 5353

pnpm ask -- "what is dnsi"
pnpm ask -- "explain quantum computing" --tcp
```

dig works as a client too (spaces are passed through into the QNAME):

```bash
dig +short TXT "What is DNSI?" @127.0.0.1 -p 5353
dig +short TXT tool.time.ask.dnsi.test @127.0.0.1 -p 5353
```

Port 53 needs privileges; develop on 5353.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DNSI_ZONE` | `dnsi.test` | zone this server answers for |
| `DNSI_TOKEN` | - | require this token for `DNSI_ZONE` (`...t.<token>.ask.<zone>`) |
| `DNSI_ZONES` | - | multi-zone override: `zone[:token],zone2[:token2]` |
| `DNSI_PORT` | `5353` | UDP and TCP port |
| `DNSI_TCP_ONLY` | off | `1` binds TCP only (recommended in production) |
| `DNSI_BACKEND` | auto | `echo` forces the echo backend |
| `DNSI_LLM_BASE_URL` | - | OpenAI-compatible base URL (enables the LLM backend) |
| `DNSI_LLM_API_KEY` | - | API key for that endpoint |
| `DNSI_LLM_MODEL` | `gpt-4o-mini` | model id |

Secrets live in the environment, never in the repo. The echo backend
needs nothing and is safe for demos.

## Production shape

1. Run behind a zone delegation: `dnsi.example.com NS ns.example.com`,
   DNSI listening on 53 of a public host. Clients then need no `-p` and
   no `@server` - the graph resolves through normal recursion, and
   resolvers cache the TTLs for the whole path.
2. Set `DNSI_TCP_ONLY=1` unless you need UDP compatibility for
   gethostbyname-only devices; TCP answers cannot be source-spoofed.
3. Put a real LLM behind it via `DNSI_LLM_*`; keep the echo backend only
   for tests.
4. Size the token bucket for your LLM budget - it is the only cost
   control. The in-flight cap (default 32) sheds excess with SERVFAIL.

## Threat model

- **DNS tunneling stigma.** Security teams will flag a DNS Q&A service.
  The answer is the posture: TCP-only, rate-limited, load-shed, zero
  logging, read-only knowledge, no secrets over plaintext DNS. It is the
  sanctioned version of a channel that exists anyway.
- **Abuse / cost.** UDP source addresses are spoofable, so per-IP limits
  are best-effort. For strict accounting, front DNSI with a resolver
  (Unbound/Bind) that applies your own policy.
- **No auth by design.** v0.1 is public knowledge. If you need private
  zones, the roadmap item is per-zone tokens encoded in the QNAME.

## Known limitations (v0.3)

- Direct questions max 200 bytes; session mode raises this to ~1000
  bytes (32 chunks, 10-minute expiry, answers not cached).
- A-mode answers cap at 64 A records (256 answer bytes); longer answers
  are cut at the cap.
- Zone tokens travel as DNS labels: they rate-limit abuse and cost, they
  do not survive an on-path observer. For real confidentiality, front
  with DoT/DoH.
- No TLS layer (DoT/DoH fronting is a deployment concern, not built in).

## Verification

```bash
pnpm verify   # typecheck + 14 tests (codec, wire, e2e over UDP+TCP)
pnpm build    # emit dist/
```
