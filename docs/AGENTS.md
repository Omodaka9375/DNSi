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
makes it a sanctioned, rate-limited, cacheable API:

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

For a security team this is the acceptable version of agent egress: one
allowlisted nameserver, per-resolver rate limits, an in-flight cap, and
zero per-user logging. The alternative is fighting tunnels.

## 2. gethostbyname-only devices

Legacy firmware, PLCs, printers, set-top boxes: code that cannot link an
HTTP client but has shipped `gethostbyname` since 1983. This is now a
first-class mode: **A-record compact answers** (PROTOCOL.md 3.3). A
`gethostbyname` call returns the answer packed into `h_addr_list`, four
answer bytes per address, in order - concatenate, strip trailing NULs,
decode UTF-8. Tools work the same way
(`gethostbyname("tool.time.ask.dnsi.test")` returns the timestamp), so a
constrained device gets a clock, an RNG and a hash without a crypto lib.

The complete C client is three lines. The A-mode cap is 256 answer
bytes per query; ask follow-up questions for more.

## 3. Hostile and captive networks

Hotel wifi, airplane wifi, industrial floors: 443 is blocked or
intercepted, 53 passes because everything breaks without it. `pnpm ask`
or `dig` is the client. Nothing is installed, nothing is registered,
nothing is logged server-side.

## 4. The knowledge graph

Every answer carries related questions as CNAMEs. The graph is the
product, not a UI nicety:

- A crawler (or an agent) starts at one question and walks CNAMEs like
  links - the answer tree becomes browsable by any resolver.
- Related answers hit the server cache and the resolver cache; popular
  paths cost zero LLM calls.
- Because questions are domains, the graph can be delegated: point an NS
  record at a specialist DNSi (a medical zone, a legal zone) and the
  client needs no new configuration.

Example walk (in demo mode, where the server repeats your question back):

```text
dig TXT "What is DNSi?" @server
  TXT  "DNSi (echo backend): What is DNSi?"   ; literal server output, demo mode
  CNAME what-is-dnsi.ask.dnsi.test
  CNAME list-tools.ask.dnsi.test

dig TXT what-is-dnsi.ask.dnsi.test @server   ; follow the graph
  TXT  "DNSi (echo backend): what is dnsi"
```

## 5. Client checklist

1. Encode the question with the DNSi rules (space -> `-`, other bytes ->
   `%XX`, labels <= 50 bytes, question <= 200 bytes).
2. Query `<labels>.ask.<zone>` TXT over UDP or TCP.
3. Concatenate TXT character-strings in order (they are UTF-8-safe).
4. Follow CNAMEs for related questions.
5. Honor TTLs: 60 dynamic, 3600 canonical. Cache aggressively; that is
   the design.
6. On classic UDP, a TC=1 response means "retry over TCP" (PROTOCOL.md
   3.4). The reference client does this for you via `queryTcp`.
7. Never send secrets: DNS is plaintext.

A TypeScript reference client ships in `src/query.ts`
(`queryUdp` / `queryTcp`, plus `aRecordsToText` for the A mode); the CLI
is `pnpm ask -- "question" [--tcp] [--a]`.
