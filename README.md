<h1><img src="docs/logo.svg" alt="DNSi" height="27" style="vertical-align:-16px"> DNSi</h1>

[![npm](https://img.shields.io/npm/v/dnsi?label=npm%20dnsi)](https://www.npmjs.com/package/dnsi)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-green)](package.json)

**Access LLMs from any device, on any network, using nothing but DNS.**

No app. No login. No HTTP. Every computer, router, printer and embedded
controller on earth can look up a domain name. DNSi turns that lookup into a
question, and the answer comes back as the reply.

```bash
pnpm ask -- "how do I split a git commit"
# answer comes back, plus related questions worth asking next
```

**Jump to:** [Why it exists](#why-it-exists) ·
[Use cases](#what-people-use-it-for) · [How is this different](#how-is-this-different) ·
[Modes](#three-ways-to-run-it) · [Quick start](#quick-start) ·
[Costs](#running-costs) · [Install](#install) · [Documentation](#documentation)

## Why it exists

Some networks block everything except DNS: hotel wifi, airplanes, locked-down
offices. Some devices cannot run apps at all: sensors, PLCs, 20 year old
firmware. All of them can look up a name. DNSi is the question box that works
in exactly those places, because it is nothing but a name lookup.

## What people use it for

- **Terminal Q&A.** One command instead of opening a browser.
- **Blocked networks.** The one lane every network leaves open.
- **Dumb devices.** A `gethostbyname` call returns the answer text. Also gives
  constrained devices a clock, a UUID and a hash without any libraries
  (`tool.time`, `tool.uuid`, `tool.hash`).
- **Team knowledge.** Run one on the office network. "how-do-i-connect-to-the-vpn"
  becomes a name every employee can look up. IT writes it once, everyone asks
  by typing, and repeated questions are served from cache for free.
- **AI agents.** Sandboxed agents that may only resolve DNS get a sanctioned
  question and tool channel, rate limited and log-free.

## How is this different

Asking an AI over DNS exists as demo projects. DNSi is built as a service
instead of a demo:

- **Tool calls, not just chat.** `tool.time`, `tool.uuid`, `tool.hash` are
  answered locally in microseconds and never touch the AI.
- **Dumb devices first.** A plain `gethostbyname` call returns the answer
  text. No TXT parsing, no special client.
- **A knowledge graph.** Every answer carries related questions as resolvable
  names, so clients and resolvers can walk from one question to the next.
- **Deployable engineering.** Long questions ride in sessions, large answers
  negotiate EDNS, private zones use tokens, and the whole thing is 35 kB with
  zero runtime dependencies.

## Three ways to run it

| Mode | Who can ask | Use it for | Cost |
|---|---|---|---|
| Your machine (loopback) | only you | personal terminal Q&A, trying it out | free |
| Your LAN | everyone on the network | team knowledge, device fleet | free + LLM tokens |
| The internet | anyone, or token holders | public utility, paid service | ~$5 VPS + LLM tokens |

The mode is decided by where the server runs, not by the code. One deployment
can serve an open zone and a token-protected zone at the same time
(`DNSI_ZONES=public.example.com,internal.example.com:secret`).

## Quick start

```bash
npx dnsi-ask "what is dnsi"   # asks the public demo server (dnsi.dev, once live):
                              # prepared answers about DNSi, no AI, no key needed
```

Run your own:

```bash
pnpm install
pnpm start                       # window 1: the server (demo mode, no API key)

pnpm ask -- "what is dnsi" --local   # window 2: ask your own server
```

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
the internet, built with the safeguards security teams expect: rate limits,
load shedding, zero per-user logging, and an option to answer over TCP only.
Questions and answers are plain text, so do not send passwords through it.

## Install

```bash
npm install -g dnsi
dnsi-ask "your question"    # asks the public instance (dnsi.dev) by default
dnsi-ask "your question" --local   # asks a server on your own machine
dnsi-server                 # run your own nameserver
```

Requires Node 22+. 35 kB download, zero runtime dependencies.

## Documentation

- [PLAIN.md](docs/PLAIN.md) - what this is in plain words, and when to use it
- [PROTOCOL.md](docs/PROTOCOL.md) - the exact wire format, with a captured transcript
- [AGENTS.md](docs/AGENTS.md) - deep dive on agents, devices and hostile networks
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) - components, caching, security posture
- [OPERATIONS.md](docs/OPERATIONS.md) - deployment, configuration, threat model

## Development

```bash
pnpm verify      # typecheck + 47 tests
pnpm build       # emit dist/
```
