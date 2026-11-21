# DNSI in plain words

## What is this?

You know directory assistance? You dial a number, say a name, and a person
tells you the answer.

The internet has had a directory assistance service since 1983. It is called
DNS. Every phone, laptop, router, fridge and industrial robot on earth can
call it, no app required. But it only knows one kind of answer: "what number
is this name?"

DNSI teaches that old service a new trick. Now you can dial it and ask
anything, and an AI answers.

```text
you:    ask "why is the sky blue"        (as a weird-looking website name)
dnsi:   "Because air scatters blue light more than red..."   (as a text answer)
```

That is the whole idea. No app to install. No account. No website to open.
If your device can look up a domain name, it can ask an AI a question.

## When would I actually use this?

**1. The network is blocking you.**
Hotel wifi, airplane wifi, office networks, whole countries. They block
apps and websites. They almost never block DNS, because the internet
stops working without it. DNSI rides that one open lane.

**2. You live in a terminal.**
You are already in a shell. Opening a browser, logging into a chat site,
waiting for the page - that is five steps. This is one:

```bash
pnpm ask -- "how do I find large files on linux"
```

**3. You have a dumb device.**
A printer, a sensor, a 20-year-old industrial controller. It cannot run
apps. It can only look up names. It can now ask "what time is it",
"what is the hash of this", or a real question.

**4. You want one place your whole team can ask.**
Your company runs its own DNSI. Now "how do I connect to the vpn" is a
name anyone inside the network can look up. IT writes the answer once.
Everyone asks by typing. No wiki, no ticket queue, no intranet.

## Okay, but is it a hack?

It is a *repurposing*, and it is deliberate.

DNS was built to carry questions and answers. DNSI just points it at a
machine that can actually answer. That said, we are not pretending it is
normal: using DNS this way surprises security people, so DNSI is built
with the safety features they would demand anyway - rate limits, no
logging of who asked, and an option to only accept the most careful
connection type. It is the polite version of a technique that already
exists, done on purpose instead of by attackers.

Two honest limits:
- The questions and answers travel in plain text. Do not send passwords.
- A single question is short (about 200 characters). Longer questions are
  split into pieces automatically; you will not notice, but it is not
  made for pasting whole documents.

## Try it in one minute

```bash
pnpm install
pnpm start                 # window 1: your own question box

pnpm ask -- "what is dnsi" # window 2: ask it anything
```

Works with normal tools too:

```bash
dig +short TXT "what is dnsi" @127.0.0.1 -p 5353
```

And when you want real AI answers instead of the built-in demo mode, point
it at any AI provider:

```bash
DNSI_LLM_BASE_URL=https://api.openai.com/v1 \
DNSI_LLM_API_KEY=sk-... \
pnpm start
```

## The one-sentence pitch

For people stuck on locked-down networks or tiny devices who cannot open a
browser or install an app, DNSI is a question box that works anywhere the
internet's phone book works, unlike chat apps that need ports, accounts
and installs.

**Tagline:** Ask anything, anywhere. No app.
