#  Troubleshooting

Each entry starts with what you see, then what it means and what to
do. The messages are quoted as shuntd prints them.

Two tools answer most questions:

```bash
shunt instance list
```

```bash
shunt service status
```

The first shows every instance, its port, whether it is running, and
which build. The second shows what the service manager thinks next to
what the port says. When those two disagree, that disagreement is
usually the answer.

##  shuntd will not start

###  No config

```
❌ No config found in ~/.config/shuntd
Please run 'shunt config generate' to launch the interactive setup guide.
```

The instance has no `config.jsonc` or `config.json`. Run the command
it names. For a named instance, the command includes `-i <name>`.

###  The config is broken

```
❌ ~/.config/shuntd/config.json is not valid JSON or JSONC:
Cannot parse JSONC: unexpected end of JSONC input
```

A syntax error, often a missing brace or a stray comma. JSONC allows
comments; it does not forgive broken structure.

```
❌ Invalid config in ~/.config/shuntd/config.jsonc:
- unknown field 'listen_prot' — check the spelling
```

Every problem is listed at once, each with its path. Unknown fields
are errors on purpose, so a typo cannot be silently ignored. A model
named anywhere — `global_default_model`, a persona's
`default_model`, `semantic.active` — must exist in the catalog. See
`docs/configuration.md`.

###  The port is taken

```
❌ Port 11435 is already in use.
   Another shuntd is already serving this instance ('default', pid 13995).
   Usual cause: a second supervisor — brew services, shunt service, or a dev run left open.
```

Two copies of the same instance. The usual culprit is a terminal run
left open while the service is installed, or both `brew services`
and `shunt service` running it. Stop one. The pid says which process
to stop.

If the message names a **different** instance, two instances share a
`listen_port`; change one. If it says the holder **is not shuntd**,
something else owns the port; change `listen_port` in the folder the
message names.

Under the service, a refused start retries every few seconds, so the
message repeats in the log until the clash is fixed. That is
deliberate.

##  shuntd starts, with warnings

###  Reserved tags

```
⚠️  Tag 'TAG_WRITER' is reserved: nothing emits it yet, so claiming it never matches. Remove the claim.
```

A model or persona claims a tag nothing produces, so that claim does
nothing. Delete it from the config. Configs generated before this
check existed often have these.

A similar warning that says **"Check for a typo"** means the tag is
not in the vocabulary at all.

###  Tier 3 is off

```
⚠️  Tier 3 unavailable, continuing without it: Embedding request returned HTTP 404. Is 'bge-m3:latest' pulled? ...
```

The embedding model is missing from the backend. Pull it:

```bash
ollama pull bge-m3
```

```
⚠️  Tier 3 unavailable, continuing without it: Profile declares dim 768 but 'bge-m3:latest' returned 1024. ...
```

The profile's `dim` does not match the model. Set it to the number
the message reports.

Routing keeps working on Tiers 1 and 2 either way. Restart after
fixing it.

###  A warning about request.signal

```
Deno.serve: request.signal aborts on successful responses (legacy behavior). ...
```

Printed once at boot by compiled binaries. It is expected and
harmless; `docs/releasing.md` explains why.

##  Requests fail

###  400, unmet_requirement

```
No model in this shuntd catalog claims TAG_VISION, so nothing here can handle images. Add TAG_VISION to the capabilities of a model that can.
```

The request has an image or audio, and no catalog model claims it can
handle that. If one of your models can, add the tag to its
`capabilities`. If none can, the refusal is correct.

###  400, too large for every model

```
No model in this shuntd catalog fits a request of about 1500000 tokens. The largest context window in the catalog is 393216.
```

The whole conversation is bigger than any model's `max_context`.
Start a new conversation, or have the client trim history.

###  502, upstream unreachable

```
shuntd could not reach its upstream at http://127.0.0.1:11434: fetch failed
```

shuntd is fine; the backend is not answering. Check that Ollama is
running and that `upstream_url` is right.

##  Requests are refused (403)

shuntd checks no credentials, so it serves only clients on the same
machine and refuses anything that looks otherwise. Each refusal is
logged as a line starting with `🚫`, with its reason and source.

###  proxy_attribution_required

```
Refused: the request carries 'x-forwarded-for', so it came through a proxy. shuntd only serves clients on this machine directly.
```

A reverse proxy — Caddy, nginx, `tailscale serve` — is passing
requests to shuntd. On the same machine, every proxied request looks
local, including ones from strangers, so shuntd refuses them. Point
the client at `127.0.0.1:11435` directly instead of through the
proxy. Serving through a proxy needs per-client keys, planned after
v1.

###  origin_not_allowed

```
Refused: the request came from a web page (Origin 'https://evil.example'). shuntd does not serve browsers.
```

A web page in a browser tried to call shuntd. Any site you visit can
send requests to `127.0.0.1`, so every request carrying an `Origin`
header is refused. Server-side apps such as Open WebUI's backend send
none.

###  host_not_allowed

```
Refused: Host 'attacker.example' is not a local name. Use 127.0.0.1 or localhost.
```

The request named a host other than `localhost`, `127.0.0.1`, `[::1]`
or `host.docker.internal`. A site that points its own name at your
machine — DNS rebinding — is refused this way. If a container sends
another name, such as Podman's `host.containers.internal`, use host
networking; see `docs/clients.md`.

###  management_not_allowed

```
Refused: '/api/pull' manages Ollama's models and is not served through shuntd. Call Ollama directly.
```

Pulling, pushing, creating, copying and deleting models are Ollama's
job, not a router's. Run `ollama pull` or call Ollama on port 11434.

###  Another machine cannot connect

shuntd listens on `127.0.0.1` only, so nothing beyond this machine
can reach it. That is deliberate until per-client keys exist, after
v1.

##  Requests go to the wrong model

Start with `explain`. It shows the tags, the tier, and why every tier
that declined, declined — without generating anything:

```bash
curl -s http://127.0.0.1:11435/shuntd/v1/explain \
    -H "Content-Type: application/json" \
    -d '{"model": "shuntd", "messages": [{"role": "user",
        "content": "the prompt that misrouted"}]}'
```

Then match what you see:

**Everything goes to the global default.** Check `abstentions`. A
Tier 2 reason that says tags matched no capability means no model
claims the tags the prompt produced. A boot warning about tags will
usually say the same thing.

**Short prompts land on the wrong persona.** Tier 3 is choosing by
meaning. Look at `semantic.score` and `semantic.margin`. Add an
exemplar shaped like the prompt to the persona it should reach. Do
not lower the threshold. `shunt probe` checks many prompts at once.

**Requests go to a small model for no reason.** The request probably
sets `stream: false`, which marks it as background work. Many SDKs do
this. See "Background requests" in `docs/routing.md`.

**A model is skipped.** `skipped` in the `explain` output says why,
usually that the conversation does not fit its `max_context`.

##  The service

###  install refuses

```
❌ No 'shuntd' on PATH. Deploy a build first (docs/releasing.md) or pass --bin <path>.
```

The service runs a compiled binary. Build and install one first, as
`docs/releasing.md` describes.

```
❌ :11435 is already served by instance 'default' (pid 80797) outside this service. Stop it first.
```

A shuntd started by hand — usually a terminal run of the source as
the default instance — already holds the port. Stop it, then install.
`deno task dev` runs the `dev` instance on its own port, so it never
blocks this.

```
❌ systemd --user is not available in this session: ...
```

Linux only. There is no user service manager here, which is common
in containers and some minimal installs.

###  The service stopped when I logged out

Linux only. User services stop at logout unless lingering is on for
your user:

```bash
loginctl enable-linger
```

###  Where the logs are

| Platform | Logs |
| --- | --- |
| macOS | `~/Library/Logs/shuntd/org.shuntd.router.out.log` and `.error.log` |
| Linux | `journalctl --user -u shuntd` |

Warnings print to the error log on macOS.

###  It is running an old build

`shunt instance list` shows each instance's version. Code changes
reach the service on your machine only after a deploy: build,
install, then `shunt service restart`. See `docs/releasing.md`.

##  Instances

```
❌ Invalid instance name 'Dev': use lowercase letters, digits and hyphens, starting with a letter or digit.
```

```
❌ Instance name 'default' is reserved. Omit the name to use the default instance.
```

See `docs/instances.md` for naming. A **blocked** state in
`instance list` means another instance holds this one's port.

##  The shell and the system

**"zsh: correct 'shunt' to 'shout'".** zsh has not noticed the new
command yet. Run `rehash`, or open a new terminal.

**"Background Items Added".** macOS shows this the first time a
service is installed. It is expected.

**A downloaded binary will not open on macOS.** Release binaries are
not signed yet, so Gatekeeper blocks them when the archive came
through a browser. Issue #7 tracks signing. Until then, clear the
quarantine flag yourself, only on a download you trust:

```bash
xattr -d com.apple.quarantine shuntd shunt
```

##  Generating a config

```
❌ Could not detect any active local AI backends.
```

Ollama is not running, or not at the default address. Start it, or
pass `--host <url>`.

```
❌ Generator Error: No models found in Ollama at http://127.0.0.1:11434. Please pull a model first (`ollama run <model>`).
```

Ollama is running but has no models. Pull at least one chat model,
and an embedding model such as `bge-m3` for Tier 3.

##  Still stuck

Search the [open issues](https://github.com/shuntd-dev/shuntd/issues),
including the `known-gap` label, which lists every known limitation.
Open a new issue with the `explain` output for a routing problem, or
the log lines for anything else.
