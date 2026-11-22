# Running DNSi

Who this is for: whoever deploys and operates the server. For a plain-language
introduction see [PLAIN.md](PLAIN.md); for the exact wire format see
[PROTOCOL.md](PROTOCOL.md).

Terminology used below: "demo mode" (also called the echo backend) is the
built-in mode that repeats your question back instead of calling an AI. It
exists so the server runs with no configuration and no API key.

## Local

```bash
pnpm install
pnpm start            # demo mode (repeats questions), UDP+TCP on 5353

pnpm ask -- "what is dnsi" --local
pnpm ask -- "explain quantum computing" --local --tcp
```

dig works as a client too (use the encoded name form; see PROTOCOL.md 2):

```bash
dig +short TXT what-is-dnsi.ask.dnsi.test @127.0.0.1 -p 5353
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
| `DNSI_BACKEND` | auto | `echo` forces demo mode |
| `DNSI_ANSWERS` | - | path to a prepared-answers JSON file: a topic demo with no AI (see `examples/answers.json`). Takes precedence over the LLM backend |
| `DNSI_LLM_BASE_URL` | - | OpenAI-compatible base URL (enables the LLM backend) |
| `DNSI_LLM_API_KEY` | - | API key for that endpoint |
| `DNSI_LLM_MODEL` | `gpt-4o-mini` | model id |
| `DNSI_LLM_TIMEOUT_MS` | `15000` | abort timeout for LLM calls; a stalled provider cannot hold in-flight slots |
| `DNSI_RATE_BURST` | `20` | token-bucket burst per client address (on by default) |
| `DNSI_RATE_REFILL` | `1` | tokens refilled per second per client address |
| `DNSI_RATE_LIMIT` | on | `off` disables the per-client rate limiter (not recommended) |
| `DNSI_STATS` | off | `1` serves aggregate (anonymous) counters at `stats.ask.<zone>` TXT |
| `DNSI_STATS_FILE` | - | persist counters across restarts; load on boot, save every 5 min |
| `DNSI_DOH_PORT` | off | serve DoH (RFC 8484) wire format at `/dns-query` on this port |
| `DNSI_DOT_PORT` | off | serve DoT (RFC 7858) on this port (needs TLS cert + key) |
| `DNSI_TLS_CERT` / `DNSI_TLS_KEY` | - | PEM files for DoH/DoT TLS termination |

Secrets live in the environment, never in the repo. Demo mode
needs nothing and is safe for demos.

**Counters are anonymous by design**: metric names and integers only, no
addresses, no questions, nothing written anywhere unless
`DNSI_STATS_FILE` is set (then a single JSON blob, no history, no
per-client data). The public instance runs with `DNSI_STATS=1` so
`dig +short TXT stats.ask.dnsi.dev` shows what the site's badge shows.

## Demo server (prepared answers, no AI)

The public demo at dnsi.dev runs a canned backend: a fixed set of prepared
questions and answers about DNSi, served with no AI, no API key, and an
instant reply. Unknown questions get a friendly default that lists what to
ask. Run it locally:

```bash
DNSI_ANSWERS=examples/answers.json pnpm start
pnpm ask -- "what is dnsi" --local
```

The JSON shape: `{"default": "...", "questions": {"<question>": {"answer":
"...", "related": ["follow-up question", ...]}}}`. Matching ignores case,
trailing punctuation and extra spaces. Related entries become `dig TXT`
hints appended to the answer. Prepared answers are canonical and cache
for an hour.

## Production shape

1. Run behind a zone delegation: `dnsi.example.com NS ns.example.com`,
   DNSi listening on 53 of a public host. Clients then need no `-p` and
   no `@server` - the graph resolves through normal recursion, and
   resolvers cache the TTLs for the whole path.
2. Set `DNSI_TCP_ONLY=1` unless you need UDP compatibility for
   gethostbyname-only devices; TCP answers cannot be source-spoofed.
3. Put a real LLM behind it via `DNSI_LLM_*`; keep demo mode only
   for tests.
4. The per-client token bucket is on by default (burst 20, 1/sec) and is
   the main cost control - size it for your LLM budget with
   `DNSI_RATE_BURST` / `DNSI_RATE_REFILL`. The in-flight cap (default 32)
   sheds excess with SERVFAIL.

## Threat model

- **DNS tunneling stigma.** Security teams will flag a DNS Q&A service.
  The answer is the posture: TCP-only, rate-limited, load-shed, no per-user
  logs in this process, read-only knowledge, and no secrets over plaintext DNS.
  Deployment still requires explicit authorization from the network operator.
- **Abuse / cost.** UDP source addresses are spoofable, so per-IP limits
  are best-effort. For strict accounting, front DNSi with a resolver
  (Unbound/Bind) that applies your own policy.
- **Public by default.** Token-protected zones are supported (see
  PROTOCOL.md 4.6): a wrong or missing token is refused. Tokens gate abuse
  and cost, but are visible in query names and provide no confidentiality.
  DoT/DoH can protect a compatible client's connection to DNSi. They do not
  encrypt a legacy device's separate path to its recursive resolver, and
  upstream resolvers may still observe or log names.

## Known limitations (v0.4)

- Direct questions max 200 bytes; session mode raises this to ~1000
  bytes (32 chunks, 10-minute expiry, answers not cached).
- A-mode answers cap at 64 A records (256 answer bytes); longer answers
  are cut at the cap.
- Zone tokens travel as DNS labels: they limit access and cost, but do not
  provide confidentiality. DoT/DoH are built in, require PEM cert/key files,
  and protect only the compatible client-to-DNSi connection.
- The DNSi process does not log per-user queries. Recursive resolvers and
  network operators may still observe or log them.
- DNS-provided time and UUIDs are unauthenticated utilities. Do not use them
  for trusted time, secret generation, or other security decisions.

## CLI reference

```bash
dnsi-ask "your question" [options]          # installed: npm i -g @omodaka/dnsi
dnsi-ask --tool <time|uuid|echo|hash> [args...] [options]
npx --package=@omodaka/dnsi dnsi-ask "your question"   # without installing
```

| Flag | Meaning |
|---|---|
| `--local` | query 127.0.0.1:5353 (zone `dnsi.test`) instead of `dnsi.dev` |
| `--server <host>` | nameserver address (default `dnsi.dev`, or `DNSI_HOST`) |
| `--port <port>` | nameserver port (default 53, or `DNSI_PORT`) |
| `--zone <zone>` | zone suffix (default `dnsi.dev`, or `DNSI_ZONE`) |
| `--token <t>` | per-zone token (`DNSI_TOKEN`) |
| `--tcp` | send the query over TCP |
| `--a` | compact A-record answer (gethostbyname mode) |
| `-h, --help` | usage |
| `-v, --version` | version |

`tool.<name>` as the first word is auto-detected, so
`dnsi-ask tool.hash hello` works too (the CLI comes from
`npm i -g @omodaka/dnsi`; `npx --package=@omodaka/dnsi dnsi-ask ...` runs
it without installing). Questions over 200 bytes ride in
sessions automatically; network failures print one clean line with an
`--local` hint when the default public target is unreachable.

## Verification

```bash
pnpm verify   # typecheck + 67 tests (codec, wire, backends, transports, e2e)
pnpm build    # emit dist/
```
