# DNSI Architecture

One process, zero runtime dependencies. The DNS wire code is hand-rolled
(`src/wire.ts`) because DNSI is a protocol project and needs exact
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
| `src/wire.ts` | DNS wire format: parse queries, encode TXT/CNAME answers, `chunkUtf8` |
| `src/name.ts` | Question <-> QNAME codec, `parseDnsiQname` (zone dispatch)            |
| `src/server.ts` | UDP + TCP sockets, `Dnsi` resolver class, orchestration              |
| `src/cache.ts` | LRU cache keyed by QNAME, TTL-aware ("answers served free")          |
| `src/ratelimit.ts` | Per-client token bucket                                         |
| `src/tools.ts` | The tool surface: time, echo, uuid, hash                             |
| `src/backend.ts` | `EchoBackend` (zero-config) and `OpenAICompatBackend`              |
| `src/index.ts` | Entrypoint: env -> options, one startup log line, nothing else       |
| `src/query.ts` | Reference client (`queryUdp` / `queryTcp`)                           |
| `src/ask-cli.ts` | `pnpm ask -- "question"`                                           |

## Request flow

1. `parseQuery` decodes id + first question (follows compression
   pointers); malformed datagrams are silently dropped.
2. Optional per-IP rate limit; an empty bucket answers SERVFAIL.
3. `parseDnsiQname` classifies: foreign name -> NXDOMAIN, `tool.*` ->
   tool call, bare zone -> usage, else question.
4. Cache lookup by exact QNAME (LRU, expiry checked on read).
5. Tool results are computed locally and synchronously. Questions go to
   the backend under an in-flight cap; over the cap answers SERVFAIL
   (load shedding instead of queueing).
6. The answer becomes one TXT record (UTF-8-safe 255-byte strings) plus
   up to 3 related-question CNAMEs, cached for the answer TTL, then
   encoded back onto the wire.

## Backends

- `EchoBackend` - deterministic, used by tests and demos. Canonical
  answers would be a lie for an LLM, so it reports dynamic (TTL 60).
- `OpenAICompatBackend` - any `/chat/completions` endpoint (OpenAI, Groq,
  OpenRouter, Ollama). The model is prompted to append a `RELATED:` line
  with 2-3 follow-up questions; those become the CNAME graph. HTTP
  failures and shape-invalid JSON raise, surfacing as SERVFAIL.

## Caching semantics

- Key: the exact QNAME (lowercased by the wire decoder). No semantic
  normalization in v0.1 - `hello world` and `HELLO WORLD` are different
  names, which is honest since questions are case-sensitive strings.
- Entry: records + expiry; expired entries are evicted on read.
- Canonical tool answers (hash, uuid, echo) are cached 3600; `time` is
  never cached. LLM answers cache for 60.

## Security posture

- TCP-only mode (`DNSI_TCP_ONLY=1`) removes UDP spoofability.
- No per-user logging anywhere; the process prints one startup line.
- Rate limiting is best-effort (UDP source addresses are spoofable);
  it is abuse mitigation, not authentication. There is no auth in v0.1
  by design: the API is read-only knowledge, and the cost control is
  the token bucket plus the in-flight cap.

## Testing

`pnpm verify` = `tsc --noEmit` + 14 node:test tests: name codec
roundtrips (ascii, unicode, length limits), wire chunking, and six
end-to-end tests driving the real server over UDP and TCP (question +
CNAME graph, tools, NXDOMAIN, rate limit, usage, cache behavior).
