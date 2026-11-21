# DNSI: Domain Name System Intelligence

DNS is the most reachable API on earth: every OS, router, and embedded device
speaks it. DNSI points that 1983 question-answering machine at an LLM.

**Killer use case:** the knowledge and tool API for environments that have no
HTTP client. Sandboxed AI agents (code interpreters, CI containers) may only
do DNS. Embedded and legacy systems only have `gethostbyname`. Hostile and
captive networks allow port 53 through when 443 is blocked. For all of them,
a question is a hostname and an answer is a DNS record.

## Wire contract

- **Question in the QNAME.** `What is DNSI?` becomes
  `what-is-dnsi.ask.dnsi.test` (space -> `-`, everything outside `[a-z0-9]`
  percent-encoded, packed into labels of <= 50 bytes).
- **Answer in TXT.** The response body is chunked into 255-byte strings on
  UTF-8 code point boundaries.
- **Related questions as CNAME.** Each answer carries CNAMEs pointing at
  follow-up questions, which are themselves resolvable. Knowledge becomes
  addressable: a question is a domain name you can cache, delegate, resolve.
- **Tool calls.** `tool.time.ask.dnsi.test`, `tool.hash.<input>.ask...`
  (`time`, `echo`, `uuid`, `hash`). Deterministic results are canonical.
- **TTLs.** 60 for dynamic answers (LLM output, time), 3600 for canonical
  (deterministic tool results). Answers get served free from cache forever
  after the first resolution.
- **Opsec.** Answer over TCP only is one flag away (`DNSI_TCP_ONLY=1`).
  Per-resolver token-bucket rate limiting, in-flight cap with SERVFAIL
  shedding, no per-user logging (one startup line, nothing else).

## Quickstart

```bash
pnpm install
pnpm start            # echo backend, udp+tcp on 5353

# another terminal
pnpm ask -- "what is dnsi"
pnpm ask -- "explain quantum computing" --tcp
```

## LLM backend

Point it at any OpenAI-compatible endpoint:

```bash
DNSI_LLM_BASE_URL=https://api.openai.com/v1 \
DNSI_LLM_API_KEY=sk-... \
DNSI_LLM_MODEL=gpt-4o-mini \
pnpm start
```

With no configuration DNSI runs the deterministic echo backend (used in tests
and demos). The model is asked for its answer plus a `RELATED:` line; the
related questions become the CNAME graph.

## Client

Anything that resolves DNS. `dig`:

```bash
dig +short TXT "what is dnsi" @127.0.0.1 -p 5353
dig +short TXT tool.time.ask.dnsi.test @127.0.0.1 -p 5353
```

Node/TS: `import { queryUdp, queryTcp } from "./src/query.js"`.
Python stdlib (`gethostbyname` only devices) is a doc topic; the A-record
compact-answer mode is tracked as a follow-up.

## Env

| Variable | Default | Meaning |
|---|---|---|
| `DNSI_ZONE` | `dnsi.test` | zone this server answers for |
| `DNSI_PORT` | `5353` | UDP and TCP port |
| `DNSI_TCP_ONLY` | off | `1` binds TCP only |
| `DNSI_BACKEND` | auto | `echo` forces the echo backend |
| `DNSI_LLM_BASE_URL` / `DNSI_LLM_API_KEY` / `DNSI_LLM_MODEL` | - | OpenAI-compatible backend |

## Development

```bash
pnpm verify      # typecheck + tests
pnpm build       # emit dist/
```

## Prior art

- github.com/duyet/llm-over-dns - prompt in QNAME, TXT back (no graph, no tools)
- github.com/mneves75/dnschat - chat client over DNS
- github.com/knadh/dns.toys - fixed utilities over DNS

DNSI's lane: agent tool-calling and the related-question knowledge graph.
