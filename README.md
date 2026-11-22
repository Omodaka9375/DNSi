<h1><img src="docs/icon.png" alt="DNSi" width="27" height="27" style="vertical-align:-8px"> DNSi</h1>

[![npm](https://img.shields.io/npm/v/@omodaka/dnsi?label=npm%20dnsi)](https://www.npmjs.com/package/@omodaka/dnsi)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-green)](package.json)

**Internal knowledge and small utilities for devices that can resolve DNS.**

No custom DNSi client. No HTTP application client on the device. DNSi turns a
standard name lookup into a question and returns a short answer. Serve prepared
runbooks and deterministic tools, or optionally connect an OpenAI-compatible
model on your own server. Compatible DNS resolution is required.

```bash
npm install -g @omodaka/dnsi
dnsi-ask "what is dnsi"
# prepared answer from the public demo: no AI involved

dnsi-ask --tool time
# current server UTC time; useful, but not authenticated
```

**Jump to:** [Why it exists](#why-it-exists) ·
[Use cases](#what-people-use-it-for) · [How is this different](#how-is-this-different) ·
[Modes](#three-ways-to-run-it) · [Quick start](#quick-start) ·
[Costs](#running-costs) · [Install](#install) · [Documentation](#documentation)

## Why it exists

Some devices cannot reasonably add an HTTPS application client: sensors, PLCs,
and old firmware. Some networks allow only tightly controlled name resolution.
Where compatible DNS is permitted, DNSi can deliver short internal instructions
and utility results through infrastructure the device already has.

## What it is for

- **Constrained devices.** A `gethostbyname` call returns short answer text.
  Serve maintenance instructions, prepared knowledge, or utility results
  without adding an HTTP application client.
- **Internal knowledge.** Run one on your network with non-confidential
  runbooks. Write an answer once; repeated questions can be served from cache.
- **Small tools.** `tool.time`, `tool.uuid`, `tool.hash`, and `tool.echo`
  answer without an AI. DNS-provided time and identifiers are unauthenticated,
  not trusted security primitives.
- **Terminal experiments.** The included CLI makes the protocol easy to try.
- **Controlled agent research.** Use DNS access only where it is explicitly
  allowed. DNSi does not make an unauthorized channel authorized.

## How is this different

Asking an AI over DNS exists as demo projects. DNSi is built as a service
instead of a demo:

- **Tool calls, not just chat.** Four built-ins - `time`, `uuid`, `echo`,
  `hash` - answer locally in microseconds and never touch the AI. From any
  language: `gethostbyname("tool.time.ask.dnsi.dev")` or
  `dig +short TXT tool.hash.hello.ask.dnsi.dev`.
- **Constrained devices first.** A plain `gethostbyname` call returns answer
  text. No TXT parsing or custom DNSi client.
- **Follow-up questions.** TXT answers can include related questions as
  resolvable names, so a client can request another prepared answer.
- **Deployable engineering.** Long questions ride in sessions, large answers
  negotiate EDNS, token-protected zones limit access, and the package has zero
  runtime dependencies.

## Three ways to run it

| Mode | Who can ask | Use it for | Cost |
|---|---|---|---|
| Your machine (loopback) | only you | protocol experiments, trying it out | free |
| Your LAN | everyone on the network | team knowledge, device fleet | free + LLM tokens |
| The internet | anyone, or token holders | public utility, paid service | ~$5 VPS + LLM tokens |

The mode is decided by where the server runs, not by the code. One deployment
can serve an open zone and a token-protected zone at the same time
(`DNSI_ZONES=public.example.com,internal.example.com:secret`).

## Quick start

```bash
npm install -g @omodaka/dnsi
dnsi-ask "what is dnsi"
# asks the public instance at dnsi.dev: prepared answers about DNSi,
# no AI, no key needed
```

**Built-in tools** (answered locally in microseconds, never touch an AI):

```bash
dnsi-ask --tool time          # current UTC time
dnsi-ask --tool uuid          # fresh UUID; use as an identifier, not a secret
dnsi-ask --tool echo hi       # repeats your text
dnsi-ask --tool hash hello    # sha256("hello")
# every tool also answers over plain dig: dig +short TXT tool.time.ask.dnsi.dev
```

Or without installing:

```bash
npx --package=@omodaka/dnsi dnsi-ask --tool time
```

Run your own server:

```bash
npm install -g @omodaka/dnsi
dnsi-server                        # demo mode: zone dnsi.test, 127.0.0.1:5353, no API key
dnsi-ask "what is dnsi" --local    # second window: ask YOUR server
```

From source instead: `git clone` this repo, `pnpm install`, `pnpm start`,
`pnpm ask -- "..." --local`.

Serve a fixed set of prepared answers (a topic demo with no AI):

```bash
DNSI_ANSWERS=examples/answers.json pnpm start
```

For real AI answers, point it at any OpenAI-compatible provider:

```bash
DNSI_LLM_BASE_URL=https://api.openai.com/v1 DNSI_LLM_API_KEY=sk-... pnpm start
```

## Running costs

- Local: free.
- Public hobby scale: a $4-6 VPS and roughly $1-5/month of AI tokens for
  1000 questions a day. Answers are cached (canonical answers for an hour,
  dynamic ones for a minute), so repeat questions cost nothing.
- Tools never touch the AI and are answered locally.

## Is this a hack?

It is a deliberate repurposing of the oldest question-answering machine on
the internet, built with rate limits, load shedding, no per-user logs in the
DNSi process, and an option to answer over TCP only. Recursive resolvers and
network operators may still log queries. Ordinary resolver lookups are
plaintext, so do not send passwords or confidential knowledge through them.
Tokens limit access and cost; they do not provide confidentiality. DoT/DoH to
DNSi does not encrypt a legacy device's separate path to its resolver.

## Install

```bash
npm install -g @omodaka/dnsi
dnsi-ask "your question"    # asks the public instance (dnsi.dev) by default
dnsi-ask "your question" --local   # asks a server on your own machine
dnsi-ask --tool time        # built-in tools: time, uuid, echo, hash
dnsi-ask --help             # all flags: --server, --port, --zone, --token, --tcp, --a
dnsi-server                 # run your own nameserver
```

Requires Node 22+. 35 kB download, zero runtime dependencies.

**Deploying for a team or the internet?** [OPERATIONS.md](docs/OPERATIONS.md)
has every environment variable, the systemd unit, and a public-instance
checklist (zone delegation, TLS for DoT/DoH, counters).

## Documentation

- [PLAIN.md](docs/PLAIN.md) - what this is in plain words, and when to use it
- [PROTOCOL.md](docs/PROTOCOL.md) - the exact wire format, with a captured transcript
- [AGENTS.md](docs/AGENTS.md) - deep dive on agents, devices and hostile networks
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - components, caching, security posture
- [OPERATIONS.md](docs/OPERATIONS.md) - deployment, configuration, threat model

## Development

```bash
pnpm verify      # typecheck + 67 tests
pnpm build       # emit dist/
```
