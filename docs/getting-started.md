#  Getting started

From nothing to a routed request, then to a service that starts on
its own. Plan on about fifteen minutes, most of it downloading
models.

##  What you need

- **macOS or Linux**, on arm64 or x64.
- **Ollama**, running, with at least one chat model pulled. Other
  OpenAI-compatible backends work for routing; `saxby config
  generate` currently knows how to read Ollama's model list.
- **An embedding model**, optional but recommended, for Tier 3:

```bash
ollama pull bge-m3
```

##  Install

Pick one. Each way installs both programs, `saxby` and `saxbyd`.

###  With Homebrew

On macOS or Linux:

```bash
brew install saxby-tools/tap/saxby
```

Shell completions for zsh, bash and fish come with it. The formula
also offers `brew services start saxby`, but this guide runs Saxby
with `saxby service install` instead. Use one or the other, never
both: they would fight over the same port. After `brew upgrade
saxby`, run `saxby service restart` so the service picks up the new
build.

###  From the AUR

On Arch Linux, with an AUR helper such as `yay`:

```bash
yay -S saxby-bin
```

Or by hand:

```bash
git clone https://aur.archlinux.org/saxby-bin.git && cd saxby-bin
```

```bash
makepkg -si
```

Shell completions come with it. After an upgrade, run `saxby service
restart`.

###  From JSR

With Deno 2.9 or newer. These commands give each program the same
permissions the release binaries have:

```bash
deno install -g -n saxby \
    --allow-net --allow-env --allow-read --allow-write \
    --allow-run --allow-sys=uid jsr:@saxby/cli
```

```bash
deno install -g -n saxbyd \
    --allow-net --allow-env --allow-read --allow-write \
    jsr:@saxby/llm-router
```

The daemon gets no `--allow-run`, so a bug in request handling cannot
start a program. Deno will not install a version published in the
last 24 hours, so right after a release, wait a day. Completions do
not come with it; `saxby completions --help` shows how to load them.

To run Saxby as a service, use one of the other ways instead. The
`deno install` wrapper finds `deno` through `PATH`, and a service may
start with a `PATH` that does not include it
([#31](https://github.com/saxby-tools/saxby/issues/31)).

###  From a release

Pick your platform — `darwin-arm64`, `darwin-x64`, `linux-x64` or
`linux-arm64` — and the version from the releases page:

```bash
VERSION=1.0.0 TARGET=darwin-arm64
```

```bash
BASE=https://github.com/saxby-tools/saxby/releases/download/v$VERSION
```

```bash
curl -LO $BASE/saxby-$VERSION-$TARGET.tar.gz
```

```bash
curl -LO $BASE/saxby-$VERSION-$TARGET.tar.gz.sha256
```

Check the download before using it. On Linux, use `sha256sum -c`:

```bash
shasum -a 256 -c saxby-$VERSION-$TARGET.tar.gz.sha256
```

```bash
tar -xzf saxby-$VERSION-$TARGET.tar.gz
```

```bash
mkdir -p ~/.local/bin
```

```bash
install -m 755 saxby-$VERSION-$TARGET/{saxbyd,saxby} ~/.local/bin/
```

Make sure `~/.local/bin` is on your `PATH`; `saxby --version` should
answer. Downloading with `curl` avoids the macOS quarantine flag that
a browser download gets. If you did use a browser, see
[Troubleshooting](troubleshooting.md).

###  From source

With Deno 2.9 or newer:

```bash
git clone https://github.com/saxby-tools/saxby.git && cd saxby
```

```bash
deno task build
```

```bash
install -m 755 dist/saxby-*/{saxbyd,saxby} ~/.local/bin/
```

`deno task build` builds for the machine you are on.

##  Configure

```bash
saxby config generate
```

It finds Ollama, lists your models, and asks a few questions: the
port (keep `11435`), a fallback model, models for the coder and
writer roles, any other models to include, and whether to set up
Tier 3 with your embedding model. It writes
`~/.config/saxby/config.jsonc`.

The generated file is a starting point. [Configuration](configuration.md)
explains every field.

##  Try it

Start Saxby in a terminal:

```bash
saxbyd
```

It prints what it loaded, any warnings, and the port it is listening
on. In a second terminal, ask where a prompt would go. This generates
nothing and loads no model:

```bash
curl -s http://127.0.0.1:11435/saxby/v1/explain \
    -H "Content-Type: application/json" \
    -d '{"model": "saxby", "messages": [{"role": "user",
        "content": "move app/a.js into app/b.js"}]}'
```

Look at `decision.selected_model` and `decision.tier`. Then send a
real request the same way, to `/v1/chat/completions` instead of
`/saxby/v1/explain`, and the chosen model answers.

[Routing](routing.md) explains what you are seeing.

##  Run it as a service

Stop the terminal copy with Ctrl-C, then:

```bash
saxby service install
```

Saxby now starts at login and comes back if it crashes, as a
LaunchAgent on macOS or a `systemd --user` unit on Linux. Check on it
any time:

```bash
saxby service status
```

See [Services](services.md) for logs, restarts and updating to a new
build.

##  Point your apps at it

Any OpenAI-compatible app works: set its base URL to
`http://127.0.0.1:11435/v1`, any API key, and the model `saxby`.
[Clients](clients.md) walks through Open WebUI and OpenClaw.

##  Next

- [Routing](routing.md) — how a model is chosen, and how to see why.
- [Configuration](configuration.md) — tags, personas, exemplars and Tier 3.
- [Instances](instances.md) — the dev instance, which never touches
  the default instance's decision log.
- [Troubleshooting](troubleshooting.md) — when something does not work.
