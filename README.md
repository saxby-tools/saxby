# Saxby

[![CI](https://github.com/saxby-tools/saxby/actions/workflows/ci.yml/badge.svg)](https://github.com/saxby-tools/saxby/actions/workflows/ci.yml)
[![Release build](https://github.com/saxby-tools/saxby/actions/workflows/release.yml/badge.svg)](https://github.com/saxby-tools/saxby/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/saxby-tools/saxby?include_prereleases)](https://github.com/saxby-tools/saxby/releases)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

**Your own models, working as one.**

Saxby turns the AI models on your computer into a team. Your apps talk to one model, called Saxby. Behind the scenes, Saxby reads each request and hands it to the model best suited for the job: code to your coding model, a photo to a model that can see, a quick question to a fast one. Every choice is logged with its reasons, so you can see what your setup does well and fix what it doesn't.

<!-- Demo GIF or screenshot goes here. -->

Saxby was called shuntd through v0.9.3.

## Built to stand on its own

Most model routers exist to save money. Saxby exists to match the experience of top cloud AI on hardware you own.

Giant cloud models win on raw power. But they serve millions of people, so they're built for everyone and fitted to no one. They run on someone else's servers, by someone else's rules, and they can change overnight.

Saxby plays on home ground. It runs next to your files and apps, with no rate limits and no line to wait in. You pick the models, and they stay put until you change them. Many leading AI models already work like a team on the inside, handing each piece of work to a specialist. Saxby does the same with whole models, and your personas and examples teach it the terrain.

Open source already has strong pieces: capable models, fast runtimes and good chat apps. What's been missing is the stitching that makes them feel like one assistant. That's Saxby's job. As models and hardware get better, the stitching carries forward.

## Talks the way you do

A persona is a role you define, such as coder, editor or researcher, tied to the model you want for that role. Call one directly with a slash command like `/code`. Or just write normally. Saxby compares your request with example prompts you wrote for each persona and picks the closest match. Because the examples come from you, routing follows how you actually ask for things. See [how Saxby picks a model](docs/routing.md).

## See every decision

Every request leaves a record: which model got it, which rule chose it and why. You can ask Saxby to explain any choice without running a model at all.

Over time, that record answers questions people usually settle by gut feeling. Which model is pulling its weight? Which one sits idle, taking up memory? When you swap in a new model, did results get better or worse? What kinds of requests does nothing in your lineup handle well yet? The answers tell you what to download, what to delete and when your setup is ready to replace a paid service.

## Stays on your machine

Saxby is one small program. It needs no cloud account, no GPU of its own and no extra AI model to make its choices. Picking a model takes less than a millisecond for everyday prompts. It also shares your GPU fairly: reserve room for a heavy job, and model loads wait their turn instead of fighting for memory. Your prompt text is not saved unless you turn that on.

## How Saxby is built

> [!NOTE]
> Saxby is written with help from frontier AI models, including
> Anthropic's Claude Opus and Fable, which handled much of the
> routine work in the v0.9 releases. A person reviews and merges
> every change and answers for it, and AI-written commits are
> labeled as AI-written.

Software has never stood still, and the tools that build it
shouldn't either. Used well, AI catches small mistakes, holds code
to its own rules and turns months of routine work into weeks. Used
carelessly, it makes a mess. The difference is the person holding
the tool. Every gap we know about is a public issue, and every
design choice is written down with its reasons.

The goal is open, local AI that can stand on its own. Getting there
faster means using the best tools available today.

## Quick start

```bash
saxby config generate
```

```bash
saxby service install
```

Then point your apps at `http://127.0.0.1:11435/v1` with the model
`saxby`. Installing the binaries comes first; see
[Getting started](docs/getting-started.md).

## Documentation

- [Getting started](docs/getting-started.md) — install, configure,
  first request, run as a service
- [Routing](docs/routing.md) — how a model is chosen, and how to see
  why
- [Configuration](docs/configuration.md) — every field, tags,
  personas, Tier 3
- [Clients](docs/clients.md) — Open WebUI, OpenClaw, scripts
- [Instances](docs/instances.md) — the dev instance, with its own log
- [Memory broker](docs/memory-broker.md) — `saxby reserve` for heavy
  GPU jobs, and model loads that wait for room
- [Services](docs/services.md) — launchd and systemd, the default
  instance and the dev instance
- [Troubleshooting](docs/troubleshooting.md) — messages and what to
  do
- [Architecture](docs/architecture.md) — how it fits together
- [Releasing](docs/releasing.md) — building, deploying and tagging
- [Roadmap](docs/roadmap.md) — milestones and what is left

## Project

Known limitations are issues labelled
[`known-gap`](https://github.com/saxby-tools/saxby/issues?q=label%3Aknown-gap):
everything found and not yet fixed is written down there. Open
questions and ideas past v1 are in
[Discussions](https://github.com/saxby-tools/saxby/discussions).

[`AGENTS.md`](AGENTS.md) records the design decisions and the reasoning behind
them. Read it before changing behavior.

## From the lab

Saxby is tested on a real homelab, and we share what we find.
[The MacBook bake-off](https://claude.ai/artifact/Xam1N1vWQxPNydXpnvUQkW)
put six local coding models through hidden tests to pick which one
gets the coding job. The tasks, answers and grades behind it are in
[saxby-tools/lab](https://github.com/saxby-tools/lab).

## Development

```bash
deno task test
```

```bash
deno task dev
```

`deno task dev` runs the source as the dev instance on its own port,
so the service on your machine keeps running untouched. See
[Instances](docs/instances.md).

| Package | What it is |
| --- | --- |
| `packages/llm-router` | `saxbyd`, the daemon |
| `packages/cli` | `saxby`, the command line |
| `packages/core` | Contracts shared by both |
| `packages/vram-guard-mac` | Apple Silicon VRAM ceiling, macOS only |

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
