# DNSI Protocol Specification

Version 0.2. This document describes the wire contract implemented by
`src/wire.ts` and `src/name.ts`. It is the reference for building DNSI
clients and for writing the public docs.

## 1. Model

DNSI is a knowledge and tool API spoken over DNS. Three namespaces live
under one zone (default `dnsi.test`):

```text
<encoded question>.ask.<zone>        knowledge questions
tool.<name>.<args...>.ask.<zone>     tool calls
ask.<zone>                           usage / help
```

Anything outside the zone gets NXDOMAIN. Anything inside gets an ANSWER
section with TXT records; knowledge answers additionally carry CNAME
records pointing at related questions.

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
  (`buildQuestionQname` returns `null`); there is no silent truncation.
- The resulting name must fit in 253 bytes including the `ask.<zone>`
  suffix, or the question is rejected.

Example: `What is DNSI?` becomes
`%57hat-is-%44%4E%53%49%3F.ask.dnsi.test`. Decoding is the inverse;
the wire always carries lowercase (DNS names are case-insensitive), and
the decoder accepts both hex cases.

## 3. Answers

### 3.1 TXT

The answer text is split into character-strings of at most 255 bytes,
**respecting UTF-8 code point boundaries** (a naive byte split would cut
multibyte characters in half). All strings are returned as one TXT
record; a client concatenates the strings in order.

### 3.2 CNAME: the related-question graph

A knowledge answer may carry up to 3 CNAME records, each pointing at
another encoded question in the same zone. These names are themselves
resolvable: the graph is addressable, cacheable, and delegatable. A
client follows a CNAME by issuing a new TXT query for that name.

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

### 3.5 TTL policy

| Answer kind                                      | TTL   |
|--------------------------------------------------|-------|
| Dynamic (LLM output, `tool.time`)                | 60    |
| Canonical (deterministic tool results, usage)    | 3600  |

TTL 60 answers are cached by the server for their TTL; canonical answers
are served "free" from cache for an hour. Resolvers in front of DNSI get
the same effect for the whole internet.

## 4. Tool namespace

```text
tool.<name>.<args-encoded>.ask.<zone>
```

| Tool   | Args      | Result                        | Canonical |
|--------|-----------|-------------------------------|-----------|
| `time` | -         | current time, ISO 8601        | no        |
| `echo` | text      | the args                      | yes       |
| `uuid` | -         | random UUID v4                | yes       |
| `hash` | text      | SHA-256 of the args, hex      | yes       |

Tools answer TXT by default; an A query (qtype 1) returns the tool
output as A records, so `gethostbyname("tool.time.ask.dnsi.test")`
returns the timestamp bytes. Unknown tools answer with a TXT error
message listing available tools (rcode NOERROR, so the client sees the
hint). `args` are encoded with the same rules as questions (a literal
`-` in args encodes as `%2D`).

## 5. Errors

| Condition                                  | Response                     |
|--------------------------------------------|------------------------------|
| Name outside the zone                      | NXDOMAIN (rcode 3)           |
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

## 7. Limits (v0.2)

- Question: 200 UTF-8 bytes max. There is no session/continuation
  mechanism for longer questions.
- A-mode answers: 64 A records = 256 answer bytes; longer answers are
  silently cut at the cap (the client sees truncated text).
- Long TXT answers exceed classic 512-byte UDP; DNSI sets TC and clients
  retry over TCP, or resolvers use EDNS0.
- Answers are unencrypted plaintext: DNSI carries no secrets, ever.
- Answer owner names use a compression pointer (offset 12); CNAME rdata
  targets are uncompressed. Compression pointers are followed when read.

## 8. Reference transcript (echo backend)

```text
dig +short TXT "What is DNSI?" @server -p 5353
;; ANSWER (TXT, 34 bytes):
DNSI (echo backend): What is DNSI?
;; ANSWER (CNAME, related questions):
  what-is-dnsi.ask.dnsi.test
  list-tools.ask.dnsi.test

dig +short TXT tool.time.ask.dnsi.test
;; ANSWER (TXT, 24 bytes):
2026-11-21T09:07:25.269Z

dig +short TXT tool.hash.hello.ask.dnsi.test
;; ANSWER (TXT, 64 bytes):
2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824

dig +short TXT ask.dnsi.test
;; ANSWER (TXT, 136 bytes):
DNSI: send a question, e.g. what-is-dnsi.ask.dnsi.test (TXT over UDP/TCP). tools: time, echo, uuid, hash (tool.<name>.<args>.ask.<zone>)

dig +short TXT example.com
;; rcode=3 (NXDOMAIN)
```
