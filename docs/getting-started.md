#  Getting started

From nothing to a routed request, then to a service that starts on
its own. Plan on about fifteen minutes, most of it downloading
models.

##  What you need

- **macOS or Linux**, on arm64 or x64.
- **Ollama**, running, with at least one chat model pulled. Other
  OpenAI-compatible backends work for routing; `shunt config
  generate` currently knows how to read Ollama's model list.
- **An embedding model**, optional but recommended, for Tier 3:

```bash
ollama pull bge-m3
```

##  Install

###  From a release

Pick your platform — `darwin-arm64`, `darwin-x64`, `linux-x64` or
`linux-arm64` — and the version from the releases page:

```bash
VERSION=1.0.0 TARGET=darwin-arm64
```

```bash
BASE=https://github.com/shuntd-dev/shuntd/releases/download/v$VERSION
```

```bash
curl -LO $BASE/shuntd-$VERSION-$TARGET.tar.gz
```

```bash
curl -LO $BASE/shuntd-$VERSION-$TARGET.tar.gz.sha256
```

Check the download before using it. On Linux, use `sha256sum -c`:

```bash
shasum -a 256 -c shuntd-$VERSION-$TARGET.tar.gz.sha256
```

```bash
tar -xzf shuntd-$VERSION-$TARGET.tar.gz
```

```bash
mkdir -p ~/.local/bin
```

```bash
install -m 755 shuntd-$VERSION-$TARGET/{shuntd,shunt} ~/.local/bin/
```

Make sure `~/.local/bin` is on your `PATH`; `shunt --version` should
answer. Downloading with `curl` avoids the macOS quarantine flag that
a browser download gets. If you did use a browser, see
`docs/troubleshooting.md`.

Homebrew and Arch packages exist only as templates for now.

###  From source

With Deno 2.9 or newer:

```bash
git clone https://github.com/shuntd-dev/shuntd.git && cd shuntd
```

```bash
deno task build
```

```bash
install -m 755 dist/shuntd-*/{shuntd,shunt} ~/.local/bin/
```

`deno task build` builds for the machine you are on.

##  Configure

```bash
shunt config generate
```

It finds Ollama, lists your models, and asks a few questions: the
port (keep `11435`), a fallback model, models for the coder and
writer roles, any other models to include, and whether to set up
Tier 3 with your embedding model. It writes
`~/.config/shuntd/config.jsonc`.

The generated file is a starting point. `docs/configuration.md`
explains every field.

##  Try it

Start shuntd in a terminal:

```bash
shuntd
```

It prints what it loaded, any warnings, and the port it is listening
on. In a second terminal, ask where a prompt would go. This generates
nothing and loads no model:

```bash
curl -s http://127.0.0.1:11435/shuntd/v1/explain \
    -H "Content-Type: application/json" \
    -d '{"model": "shuntd", "messages": [{"role": "user",
        "content": "move app/a.js into app/b.js"}]}'
```

Look at `decision.selected_model` and `decision.tier`. Then send a
real request the same way, to `/v1/chat/completions` instead of
`/shuntd/v1/explain`, and the chosen model answers.

`docs/routing.md` explains what you are seeing.

##  Run it as a service

Stop the terminal copy with Ctrl-C, then:

```bash
shunt service install
```

shuntd now starts at login and comes back if it crashes, as a
LaunchAgent on macOS or a `systemd --user` unit on Linux. Check on it
any time:

```bash
shunt service status
```

See `docs/services.md` for logs, restarts and updating to a new
build.

##  Point your apps at it

Any OpenAI-compatible app works: set its base URL to
`http://127.0.0.1:11435/v1`, any API key, and the model `shuntd`.
`docs/clients.md` walks through Open WebUI and OpenClaw.

##  Next

- `docs/routing.md` — how a model is chosen, and how to see why.
- `docs/configuration.md` — tags, personas, exemplars and Tier 3.
- `docs/instances.md` — a separate dev copy that never touches your
  real decision log.
- `docs/troubleshooting.md` — when something does not work.
