#  shuntd

[![CI](https://github.com/shuntd-dev/shuntd/actions/workflows/ci.yml/badge.svg)](https://github.com/shuntd-dev/shuntd/actions/workflows/ci.yml)
[![Release build](https://github.com/shuntd-dev/shuntd/actions/workflows/release.yml/badge.svg)](https://github.com/shuntd-dev/shuntd/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/shuntd-dev/shuntd)](https://github.com/shuntd-dev/shuntd/releases)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

A local-first router for your own models. shuntd sits in front of an
OpenAI-compatible backend such as Ollama, shows your apps one model
called `shuntd`, and sends each request to the model in your catalog
that suits it best. Every decision is logged, with the reasons, so
you can tune routing against evidence instead of guesses.

##  How it picks

| Tier | Looks at | Sends to |
| --- | --- | --- |
| 1 | A `/command` at the start of the prompt | That persona's model |
| 2 | Code, paths, stack traces, tables, math | Models claiming those tags |
| 3 | Meaning, compared with example prompts | The closest persona's model |
| — | Nothing matched | Your fallback model |

Image and audio are requirements, not preferences: a model that
cannot see never gets an image. When nothing in your catalog can
serve a request, shuntd says so instead of guessing.

`POST /shuntd/v1/explain` shows the whole decision for any request
without generating a token. shuntd never touches the filesystem: file
paths in prompts are matched by shape only, never opened.

##  Quick start

```bash
shunt config generate
```

```bash
shunt service install
```

Then point your apps at `http://127.0.0.1:11435/v1` with the model
`shuntd`. Installing the binaries comes first; see
[Getting started](docs/getting-started.md).

##  Documentation

- [Getting started](docs/getting-started.md) — install, configure,
  first request, run as a service
- [Routing](docs/routing.md) — how a model is chosen, and how to see
  why
- [Configuration](docs/configuration.md) — every field, tags,
  personas, Tier 3
- [Clients](docs/clients.md) — Open WebUI, OpenClaw, scripts
- [Instances](docs/instances.md) — a separate dev copy with its own
  log
- [Services](docs/services.md) — launchd and systemd, dev and live
- [Troubleshooting](docs/troubleshooting.md) — messages and what to
  do
- [Architecture](docs/architecture.md) — how it fits together
- [Releasing](docs/releasing.md) — building, deploying and tagging
- [Roadmap](docs/roadmap.md) — milestones and what is left

##  Project

Known limitations are issues labelled
[`known-gap`](https://github.com/shuntd-dev/shuntd/issues?q=label%3Aknown-gap):
everything found and not yet fixed is written down there. Open
questions and ideas past v1 are in
[Discussions](https://github.com/shuntd-dev/shuntd/discussions).

`AGENTS.md` records the design decisions and the reasoning behind
them. Read it before changing behavior.

##  Development

```bash
deno task test
```

```bash
deno task dev
```

`deno task dev` runs the source as the `dev` instance on its own port,
so the service on your machine keeps running untouched. See
[Instances](docs/instances.md).

| Package | What it is |
| --- | --- |
| `packages/llm-router` | `shuntd`, the daemon |
| `packages/cli` | `shunt`, the command line |
| `packages/core` | Contracts shared by both |
| `packages/vram-mac-guard` | Apple Silicon VRAM ceiling, macOS only |

##  License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
