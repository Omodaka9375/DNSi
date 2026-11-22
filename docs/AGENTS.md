# DNSi for agents and devices

Who this is for: developers integrating DNSi into software (agents, scripts,
device firmware). For the plain-language overview, read
[PLAIN.md](PLAIN.md) first.

The strongest use: an AI question-and-tool service for environments that
have no HTTP client. Three real audiences, one protocol.

## 1. Sandboxed AI agents

AI code-interpreter sandboxes (OpenAI-style containers, cloud agent
runtimes, CI) commonly block all egress but leave DNS resolution intact -
researchers have repeatedly shown DNS is the one channel that survives
(OpenAI ChatGPT DNS exfiltration fix, Feb 2026; AWS AgentCore DNS
findings). Today that channel is only known as an attack surface. DNSi
provides a rate-limited, cacheable API for an explicitly authorized channel:

```python
# inside a locked-down sandbox: the only egress is DNS resolution
import socket, subprocess

def ask(question: str, server: str, port: int = 53) -> str:
    # if dig is not present, speak the wire format over a raw socket
    # (see PROTOCOL.md section 2 for the encoding)
    return subprocess.run(
        ["dig", "+short", "TXT", question, f"@{server}", "-p", str(port)],
        capture_output=True, text=True, timeout=30).stdout

print(ask("summarize the dnsi protocol", "dnsi.internal"))
print(ask("tool.uuid.ask.dnsi.internal", "dnsi.internal"))
```

For a security team this can be a deliberately allowed, read-only DNS gateway:
one allowlisted nameserver, per-resolver rate limits, and an in-flight cap.
The DNSi process writes no per-user query logs, but resolvers and network
controls may. DNSi does not itself make a channel authorized; that decision
belongs to the environment operator.

## 2. gethostbyname-only devices

Legacy firmware, PLCs, printers, set-top boxes: code that cannot link an
HTTP client but has shipped `gethostbyname` since 1983. This is now a
first-class mode: **A-record compact answers** (PROTOCOL.md 3.3). A
`gethostbyname` call returns the answer packed into `h_addr_list`, four
answer bytes per address, in order - concatenate, strip trailing NULs,
decode UTF-8. Tools work the same way
(`gethostbyname("tool.time.ask.dnsi.test")` returns the timestamp), so a
constrained device gets a UTC timestamp, an identifier and a hash without a
TLS or JSON stack. Time and UUIDs arrive without authentication: do not use
them as trusted time, secrets, or security tokens.

The complete C client is three lines. The A-mode cap is 256 answer
bytes per query; ask follow-up questions for more.

## 3. Restricted networks

Some networks permit DNS resolution while restricting application traffic,
but resolver destinations, names, and record types may also be filtered. Use
DNSi only with authorization. `pnpm ask` or `dig` is the client; no custom
DNSi client is required. The DNSi process writes no per-user logs, while
resolvers and network operators may log queries.

## 4. Follow-up questions

TXT answers can carry up to three related questions as `dig TXT` hints
appended to the answer text:

- A client can request a follow-up without constructing a new query name.
- Related answers can use the server and resolver caches, avoiding repeated
  model calls.
- A specialist zone can serve its own prepared follow-up answers.

Example walk (in demo mode, where the server repeats your question back):

```text
dig TXT "What is DNSi?" @server
  TXT  "DNSi (echo backend): What is DNSi?
        related:
          dig TXT what-is-dnsi.ask.dnsi.test
          dig TXT list-tools.ask.dnsi.test"

dig TXT what-is-dnsi.ask.dnsi.test @server   ; follow the graph
  TXT  "DNSi (echo backend): what is dnsi"
```

## 5. Client checklist

1. Encode the question with the DNSi rules (space -> `-`, other bytes ->
   `%XX`, labels <= 50 bytes, question <= 200 bytes).
2. Query `<labels>.ask.<zone>` TXT over UDP or TCP.
3. Concatenate TXT character-strings in order (they are UTF-8-safe).
4. Parse the `related:` block for follow-up questions.
5. Honor TTLs: 60 dynamic, 3600 canonical. Cache aggressively; that is
   the design.
6. On classic UDP, a TC=1 response means "retry over TCP" (PROTOCOL.md
   3.4). The reference client does this for you via `queryTcp`.
7. Never send secrets: DNS is plaintext.

A TypeScript reference client ships in `src/query.ts`
(`queryUdp` / `queryTcp`, plus `aRecordsToText` for the A mode); the CLI
is `dnsi-ask "question" [--tcp] [--a] [--tool <name>]`
(`npx --package=@omodaka/dnsi dnsi-ask ...` without installing) and builds
question, session and tool QNAMEs for you (`buildQuestionQname`,
`buildSessionQname`, `buildToolQname` in `src/name.ts`).
