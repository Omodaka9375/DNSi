# DNSi Protocol Specification

Who this is for: anyone implementing a DNSi client or server, or auditing
the wire behavior. It is deliberately exact; if you want the plain-language
version, read [PLAIN.md](PLAIN.md) first.

Version 0.3. This document describes the wire contract implemented by
`src/wire.ts` and `src/name.ts`. It is the reference for building DNSi
clients and for writing the public docs.

## 0. Glossary

| Term | Meaning |
|---|---|
| QNAME | the domain name being queried; DNSi puts the question in it |
| TXT | a DNS record type that carries text; DNSi puts the answer in it |
| CNAME | a pointer to another name; DNSi uses it for related questions |
| A record | a DNS record holding an IPv4 address; DNSi packs answer bytes into these |
| TTL | seconds a resolver may cache the answer (DNSi: 60 or 3600) |
| zone | the domain suffix this server is responsible for, e.g. `dnsi.test` |
| token | a secret label embedded in the name, required by private zones |
| SERVFAIL / REFUSED / NXDOMAIN | DNS error codes: server failed / refused / name unknown |
| TC | truncation flag: "answer too big for UDP, retry over TCP" |
| EDNS0 | DNS extension letting UDP responses exceed 512 bytes |

## 1. Model

DNSi is a knowledge and tool API spoken over DNS. Three namespaces live
under one or more zones (default `dnsi.test`):

```text
<encoded question>.ask.<zone>        knowledge questions
<encoded question>.t.<token>.ask.<zone>   tokenized (private) zones
sess.<sid>.<n>.<total>.<chunk>...ask.<zone>   long-question sessions
tool.<name>.<args...>.ask.<zone>     tool calls
ask.<zone>                           usage / help
```

Anything outside the zones gets NXDOMAIN. A tokenized zone queried
without its token gets REFUSED (rcode 5). Anything else gets an ANSWER
section with TXT records; related questions are appended to the answer
text as dig hints (section 3.2).

## 2. Question encoding (QNAME)

A question is a UTF-8 string encoded into DNS labels, reversibly:

| Input byte                    | Output            |
|-------------------------------|-------------------|
| `0x20` (space)                | `-` (one byte)    |
| `a-z`, `0-9`                  | literal           |
| anything else (incl. `A-Z`)   | `%` + 2 uppercase hex digits of the UTF-8 byte |

Rules:

- The encoded stream is packed greedily into labels of at most 50 bytes.
  `%XX` tokens are never split across labels.
- Questions longer than 200 UTF-8 bytes are rejected client-side
  (`buildQuestionQname` returns `null`) and by the server (the parser
  answers NXDOMAIN): there is no silent truncation, and no client can
  smuggle a longer question past the limit.
- The resulting name must fit in 253 bytes including the `ask.<zone>`
  suffix, or the question is rejected.

Example: `What is DNSi?` becomes
`%57hat-is-%44%4E%53%49%3F.ask.dnsi.test`. Decoding is the inverse;
the wire always carries lowercase (DNS names are case-insensitive), and
the decoder accepts both hex cases.

## 3. Answers

### 3.1 TXT

The answer text is split into character-strings of at most 255 bytes,
**respecting UTF-8 code point boundaries** (a naive byte split would cut
multibyte characters in half). All strings are returned as one TXT
record; a client concatenates the strings in order.

### 3.2 Related questions in the answer text

A knowledge answer may carry up to 3 **related questions**, appended to
the answer text itself:

```text
<answer text>
related:
  dig TXT <encoded-question>.ask.<zone>
  ...
```

Each hint names another encoded question in the same zone (carrying the
zone token if one is required), so the graph is addressable by typing
the hint. A client follows it by issuing a new TXT query for that name.

Earlier versions emitted these as CNAME records sharing the question's
owner name. That violates RFC 1034 3.6.2 / RFC 2181 10.1 (a node with a
CNAME must not hold other data), and strict resolvers - Google and
Cloudflare DoH JSON among them - SERVFAIL such responses. The hints are
plain text now, and every resolver accepts the answer.

### 3.3 A-record compact-answer mode (gethostbyname devices)

A query with qtype A (type 1) for a question or tool name returns the
answer packed into **A records, 4 bytes per address, in order**. A
device that can only call `gethostbyname` receives the whole answer in
`h_addr_list`: concatenate the 4-byte addresses, strip trailing NUL
padding, decode UTF-8. Cap: 64 A records per answer (256 answer bytes).

- Valid UTF-8 text never contains 0x00 or 0xFF, so octets stay clear of
  the most-filtered address values.
- A-mode answers carry no CNAME graph and no TXT; the answer text is the
  entire payload.
- A-mode and TXT answers are cached under separate keys.

```c
/* gethostbyname-only device, complete client */
struct hostent *h = gethostbyname("what-is-dnsi.ask.dnsi.test");
/* h->h_addr_list = 4-byte chunks of the UTF-8 answer */
```

### 3.4 Truncation

Classic UDP responses over 512 bytes are replaced by a header-only
response with TC=1 (rcode NOERROR, zero answers). Clients and resolvers
retry over TCP. TCP responses are never truncated.

### 3.5 EDNS0

Clients that send an OPT record announce their UDP payload size in the
OPT class. DNSi honors it, capped at its own advertised size: the UDP
response is sent whole when it fits in `min(senderSize, 1232)`,
otherwise TC=1. The double cap is deliberate. UDP source addresses are
spoofable, so a server that answers an inquirer's advertised 4096 with
4096 bytes is a reflected amplification tool (roughly 100x for a short
query). Both directions are therefore bounded by 1232, the ceiling RFC
8482 recommends. DNSi appends its own OPT record (advertising payload
size 1232) to every response for an EDNS query. Clients needing more
than that use TCP, which is not spoofable.

### 3.6 TTL policy

| Answer kind                                      | TTL   |
|--------------------------------------------------|-------|
| Dynamic (LLM output, `tool.time`)                | 60    |
| Canonical (deterministic tool results, usage)    | 3600  |

TTL 60 answers are cached by the server for their TTL; canonical answers
are served "free" from cache for an hour. Resolvers in front of DNSi get
the same effect for the whole internet.

## 4. Tool namespace

```text
tool.<name>.<args-encoded>.ask.<zone>
tool.<name>.<args-encoded>.t.<token>.ask.<zone>
```

| Tool   | Args      | Result                        | Canonical |
|--------|-----------|-------------------------------|-----------|
| `time` | -         | current time, ISO 8601        | no        |
| `echo` | text      | the args                      | yes       |
| `uuid` | -         | random UUID v4, fresh per call | no       |
| `hash` | text      | SHA-256 of the args, hex      | yes       |

Tools answer TXT by default; an A query (qtype 1) returns the tool
output as A records, so `gethostbyname("tool.time.ask.dnsi.test")`
returns the timestamp bytes. Unknown tools answer with a TXT error
message listing available tools (rcode NOERROR, so the client sees the
hint). `args` are encoded with the same rules as questions (a literal
`-` in args encodes as `%2D`), up to the 200-byte question ceiling, and
carry the zone token the same way questions do.

Reference builders: `buildQuestionQname` (questions), `buildToolQname`
(tools), and `buildSessionQname` (sessions) in `src/name.ts`. The CLI
invokes tools directly: `dnsi-ask --tool time`, or
`dnsi-ask tool.hash hello` (the `tool.<name>` prefix is auto-detected).

## 4.5 Sessions: questions over 200 bytes

A question up to 200 bytes travels in one QNAME. Longer questions (up to
~1000 bytes) ride in a session of chunk queries:

```text
sess.<sid>.<n>.<total>.<encoded-chunk>[.t.<token>].ask.<zone>
```

- `<sid>` is a random 8 hex character id chosen by the client.
- `<n>`/`<total>` are 1-based part numbers; parts may arrive in any order.
- `<encoded-chunk>` uses the question encoding, max 45 characters per
  chunk (enforced server-side), and `%XX` tokens are never split across
  chunks.
- Each incomplete part answers `stored <have>/<total>` (TXT, TTL 60).
- When all parts are present the server assembles the question in part
  order, answers it inline on the final query (TXT with related hints,
  or A records for qtype A), and deletes the session.
- Sessions expire after 10 minutes; max 32 parts, and the assembled
  question is capped at 1000 bytes server-side (a part that would cross
  the cap answers REFUSED, and the backend is never called). Session
  answers are never cached (each session id is unique). Re-sending an
  already-stored part is accepted and replaces it; its bytes are counted
  once against the budget.
- Session state is scoped per zone: the same `<sid>` used in two zones
  concurrently is two independent sessions.
- The reference client switches to session mode automatically for
  questions over 200 bytes: `pnpm ask -- "long question..."`.

## 4.6 Per-zone tokens

Zones may require a token: the query name must embed `t.<token>` right
before `ask.<zone>` (single label, `[a-z0-9-]`). A tokenized zone
queried without the correct token answers REFUSED (rcode 5); the usage
record (`ask.<zone>`) stays public. Tokens are DNS labels: they are
visible to anyone who can observe the query - they gate casual abuse
and cost, not determined adversaries.

## 5. Errors

| Condition                                  | Response                     |
|--------------------------------------------|------------------------------|
| Name outside all zones                     | NXDOMAIN (rcode 3)           |
| Tokenized zone queried without its token   | REFUSED (rcode 5)            |
| Supported qtype other than TXT/A/ANY (e.g. AAAA) | NOERROR with 0 answers (NODATA); the backend is not called |
| Rate limit exceeded for the client address | SERVFAIL (rcode 2)           |
| In-flight LLM cap exhausted                | SERVFAIL (rcode 2), load shed |
| Backend raised (upstream error)            | SERVFAIL (rcode 2)           |
| Bare zone (`ask.<zone>`)                   | NOERROR + usage TXT          |
| Malformed datagram                         | dropped, no response         |

## 6. Transport

- UDP on `DNSI_PORT` (default 5353) and TCP on the same port.
- `DNSI_TCP_ONLY=1` binds TCP only (the defensive posture: TCP answers
  cannot be spoofed and give clean framing for long answers).
- TCP uses the standard 2-byte length prefix; multiple queries per
  connection are answered in order.
- No name compression is emitted. Compression pointers are followed when
  reading.

## 7. Limits (v0.3)

- Direct questions: 200 UTF-8 bytes max; longer questions (up to ~1000
  bytes) ride in sessions (section 4.5).
- A-mode answers: 64 A records = 256 answer bytes; longer answers are
  cut at the cap (the client sees truncated text).
- Long TXT answers exceed classic 512-byte UDP; DNSi sets TC and clients
  retry over TCP, or resolvers use EDNS0.
- Answers are unencrypted plaintext: DNSi carries no secrets, ever.
- Answer owner names use a compression pointer (offset 12); no CNAME
  records are emitted. Compression pointers are followed when read.
- The LLM backend aborts upstream calls after a timeout (default 15 s,
  `DNSI_LLM_TIMEOUT_MS`) so a stalled provider cannot exhaust the
  in-flight cap.

## 8. Reference transcript (demo mode; the server repeats the question back)

```text
dig +short TXT "What is DNSi?" @server -p 5353
;; ANSWER (TXT):
DNSi (echo backend): What is DNSi?
related:
  dig TXT what-is-dnsi.ask.dnsi.test
  dig TXT list-tools.ask.dnsi.test

dig +short TXT tool.time.ask.dnsi.test
;; ANSWER (TXT, 24 bytes):
2026-11-21T09:07:25.269Z

dig +short TXT tool.hash.hello.ask.dnsi.test
;; ANSWER (TXT, 64 bytes):
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

dig +short TXT ask.dnsi.test
;; ANSWER (TXT, 136 bytes):
DNSi: send a question, e.g. what-is-dnsi.ask.dnsi.test (TXT over UDP/TCP). tools: time, echo, uuid, hash (tool.<name>.<args>.ask.<zone>)

dig +short TXT example.com
;; rcode=3 (NXDOMAIN)
```
