# DNSi Architecture

Who this is for: contributors reading or changing the code. It assumes you
know DNS basics (QNAME, TXT, CNAME, TTL); those are defined in
[PROTOCOL.md](PROTOCOL.md).

One process, zero runtime dependencies. The DNS wire code is hand-rolled
(`src/wire.ts`) because DNSi is a protocol project and needs exact
control over TXT chunking and CNAME answers.

```text
                +-------------------------------------------+
 dig / agent -->| UDP :5353 or TCP :5353 (DNSI_TCP_ONLY)    |
 / device       +---------------------+---------------------+
                                      |
                        handleQuery(msg, clientIp)
                                      |
              +-----------------------+------------------------+
              |                       |                        |
        RateLimiter             AnswerCache                parseDnsiQname
        (per-IP token           (LRU 10k, TTL-             (question | tool |
         bucket, SERVFAIL        aware)                    usage | NXDOMAIN)
         on empty)                     |                        |
              |                 hit --> answer                 |
              |                       miss                       |
              |                  +-----+------+-----------------+
              |                  |            |                |
              |             usage()      tool()         question()
              |                  |            |                |
              |                  |      runTool()      Backend.ask()
              |                  |      (sync, local)  (echo or
              |                  |            |        OpenAI-compatible)
              |                  +-----+------+-----------------+
              |                        |
              |            TXT record(s) + up to 3 CNAMEs
              |            (chunkUtf8: 255-byte, UTF-8-safe)
              |                        |
              +----------> encodeResponse() --> wire bytes
```

## Components

| File          | Role                                                                 |
|---------------|----------------------------------------------------------------------|
| `src/wire.ts` | DNS wire format: parse queries, encode TXT/CNAME/A answers, `chunkUtf8` |
| `src/name.ts` | Question <-> QNAME codec, `parseDnsiQname` (zone dispatch), session/tool qname builders |
| `src/server.ts` | UDP + TCP sockets, `Dnsi` resolver class, orchestration              |
| `src/cache.ts` | LRU cache keyed by (qtype, qname), TTL-aware ("answers served free") |
| `src/ratelimit.ts` | Per-client token bucket                                         |
| `src/tools.ts` | The tool surface: time, echo, uuid, hash                             |
| `src/backend.ts` | `EchoBackend`, `OpenAICompatBackend` (abort-timeout fetch), `CannedBackend` |
| `src/index.ts` | Entrypoint: env -> options, one startup log line, nothing else       |
| `src/query.ts` | Reference client (`queryUdp` / `queryTcp`, transaction-ID checked)   |
| `src/ask-cli.ts` | `dnsi-ask` (npm `@omodaka/dnsi`): flags, `--tool`, auto-sessions, clean errors |

## Request flow

1. `parseQuery` decodes id + first question (follows compression
   pointers); malformed datagrams are silently dropped.
2. Optional per-IP rate limit; an empty bucket answers SERVFAIL.
3. `parseDnsiQname` classifies: foreign name -> NXDOMAIN, `tool.*` ->
   tool call, bare zone -> usage, else question. Unsupported qtypes
   (anything but TXT, A, ANY) answer NODATA immediately; the backend is
   never called for them (dual-stack resolvers send AAAA/HTTPS next to
   every A/TXT query).
4. Cache lookup by (qtype, qname) (LRU, expiry checked on read).
5. Tool results are computed locally and synchronously. Questions go to
   the backend under an in-flight cap; over the cap answers SERVFAIL
   (load shedding instead of queueing). Long questions arrive as
   session chunks collected under a per-zone key, byte-budgeted at
   admission, and answered inline on the final chunk.
6. The answer becomes one TXT record (UTF-8-safe 255-byte strings) or A
   records for qtype A; up to 3 related questions are appended to the
   TXT answer as `dig TXT` hints (not CNAME records: a CNAME cannot
   share an owner with other data, RFC 1034 3.6.2). Cached for the
   answer TTL, then encoded back onto the wire.

## Backends

- `EchoBackend` - deterministic, used by tests and demos. Canonical
  answers would be a lie for an LLM, so it reports dynamic (TTL 60).
- `OpenAICompatBackend` - any `/chat/completions` endpoint (OpenAI, Groq,
  OpenRouter, Ollama). The model is prompted to append a `RELATED:` line
  with 2-3 follow-up questions; those become the related hints. HTTP
  failures and shape-invalid JSON raise, surfacing as SERVFAIL. Each
  fetch carries an `AbortSignal.timeout` (default 15 s, `DNSI_LLM_TIMEOUT_MS`)
  so a stalled provider cannot hold in-flight slots forever.
- `CannedBackend` - prepared answers from a JSON file (`DNSI_ANSWERS`),
  matched case/punctuation/whitespace-insensitively. Canonical (TTL
  3600). Powers the public demo with no AI and no API key.

## Caching semantics

- Key: the exact (qtype, QNAME) pair (names arrive lowercased by the
  wire decoder). `hello world` and `HELLO WORLD` are different names,
  which is honest since questions are case-sensitive strings; the canned
  backend does its own normalization for prepared questions.
- Entry: records + expiry; expired entries are evicted on read.
- Canonical tool answers (hash, echo) are cached 3600; `time` and `uuid`
  are never cached, since both must differ per call. LLM answers cache
  for 60. Session answers are never cached.

## Security posture

- TCP-only mode (`DNSI_TCP_ONLY=1`) removes UDP spoofability.
- UDP replies are capped at min(requestor-advertised, 1232) bytes, so
  the server cannot be used as a reflected amplification tool.
- Session state is hard-capped (10k entries, oldest-evicted), TCP
  buffers are capped (128 KB per connection) and idle TCP sockets are
  dropped after 30 s.
- No per-user logging anywhere; the process prints one startup line.
- Rate limiting is best-effort (UDP source addresses are spoofable);
  it is abuse mitigation, not authentication. There is no auth by
  design: the API is read-only knowledge, and the cost control is the
  per-zone token plus the token bucket and the in-flight cap.

## Testing

`pnpm verify` = `tsc --noEmit` + 54 node:test tests: name codec
roundtrips (ascii, unicode, length limits, tool qnames), wire chunking,
the OpenAI-compatible backend against a mocked fetch (including the
abort timeout), and end-to-end tests driving the real server over UDP
and TCP (question + related hints, tools, A mode reassembly, qtype-scoped
caching, NODATA for AAAA, NXDOMAIN, rate limit, usage, 512-byte TC
truncation, EDNS0 large-payload UDP with the 1232 ceiling,
long-question sessions incl. per-zone isolation and retry accounting,
per-zone token REFUSED/accept, multi-zone routing, canned demo).
