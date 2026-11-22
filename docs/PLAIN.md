# DNSi in plain words

## What is this?

DNS normally answers one question: "what address belongs to this name?" DNSi
uses that same lookup to return a short instruction, a prepared answer, or a
small utility result.

The main use is a machine that already has a DNS resolver but cannot reasonably
add an HTTPS application client: old firmware, a controller, or a small network
device. It needs no custom DNSi client. Your DNSi server supplies the knowledge;
AI is optional.

```text
device: look up "how-do-i-restart-this-service" as a DNS name
dnsi:   "Run systemctl restart example, then check systemctl status example."
```

The fastest way to try the public demo:

```bash
npm install -g @omodaka/dnsi
dnsi-ask "what is dnsi"
```

**That public demo serves prepared answers about DNSi. It does not use AI.**
Unknown questions receive a message explaining the demo. Its four built-in
utilities do perform real work:

```bash
dnsi-ask --tool time       # server UTC time; not authenticated
dnsi-ask --tool uuid       # an identifier, not a secret or security token
dnsi-ask --tool echo hi    # repeats your text
dnsi-ask --tool hash hello # SHA-256 of your text
```

Run your own server with no account or API key:

```bash
dnsi-server                         # window 1: local demo server
dnsi-ask "what is dnsi" --local    # window 2
```

From a source checkout, use `pnpm install && pnpm start`, then
`pnpm ask -- "what is dnsi" --local`.

## When would I actually use this?

**1. A device has a resolver but no suitable application client.**

A printer, sensor, or old controller may need one short maintenance instruction
or a service status. DNSi can serve that answer without adding an HTTP client,
JSON parser, or custom protocol client to the device.

A compact A-record mode also returns answer bytes through `gethostbyname` for
software that cannot request TXT records.

**2. You want a small internal knowledge service.**

Run DNSi on your own network and serve prepared, non-confidential runbooks.
An instruction becomes a name another machine can resolve. You control the
answers, and repeated requests can use the cache.

**3. You want a tiny utility over DNS.**

The server can return a hash, echo text, generate a UUID, or report its current
UTC time. These are demonstrations and convenience utilities, not trusted
security services. Ordinary DNS can be observed or altered, so do not use its
time as authoritative or its UUIDs as secrets.

**4. You are experimenting in a terminal.**

The included CLI makes the protocol easy to try. This is useful, but ordinary
terminal AI clients already exist; constrained devices are the reason DNSi is
different.

## What about restricted networks and agents?

DNSi works only where compatible DNS resolution is available. Networks may
restrict resolver destinations, names, or record types. It is not a promise of
connectivity on every network, and it does not make bypassing network policy
acceptable.

For agents, use DNSi only when that DNS channel is explicitly allowed and
controlled. The DNSi process writes no per-user query logs, but recursive
resolvers, network operators, and surrounding infrastructure may log queries.

## What privacy and security do I get?

- Ordinary resolver lookups are plaintext. Do not send passwords or
  confidential internal knowledge.
- A token-protected zone limits access and cost. Its token appears in the DNS
  name and does not provide confidentiality.
- DNSi supports DoT and DoH between a compatible client and the DNSi server.
  That does not encrypt a legacy device's separate path to its normal resolver.
- Time and UUIDs delivered over ordinary DNS are unauthenticated. Do not use
  them for security decisions.
- Questions are short. Longer ones are split into parts automatically, but this
  is not a document-transfer protocol.

## Try it with normal DNS tools

```bash
dig +short TXT what-is-dnsi.ask.dnsi.test @127.0.0.1 -p 5353
dig +short TXT tool.time.ask.dnsi.test @127.0.0.1 -p 5353
```

For real AI answers on your own server, point it at an OpenAI-compatible
provider. PowerShell example:

```powershell
$env:DNSI_LLM_BASE_URL = "https://api.openai.com/v1"
$env:DNSI_LLM_API_KEY = "your-key"
pnpm start
```

## The one-sentence pitch

For embedded and infrastructure developers who need short answers on machines
that cannot make HTTPS requests, DNSi is a resolver-only knowledge gateway that
delivers internal documentation and utilities through standard DNS, unlike chat
applications and HTTP-based agent frameworks.

**Tagline:** AI and internal knowledge for devices that only speak DNS.
