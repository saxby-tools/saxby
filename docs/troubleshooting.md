#  Troubleshooting

Each entry starts with what you see, then what it means and what to
do. The messages are quoted as Saxby prints them.

Two tools answer most questions:

```bash
saxby instance list
```

```bash
saxby service status
```

The first shows every instance, its port, whether it is running, and
which build. The second shows what the service manager thinks next to
what the port says. When those two disagree, that disagreement is
usually the answer.

##  Saxby will not start

###  No config

```
❌ No config found in ~/.config/saxby
Please run 'saxby config generate' to launch the interactive setup guide.
```

The instance has no `config.jsonc` or `config.json`. Run the command
it names. For a named instance, the command includes `-i <name>`.

###  The config is broken

```
❌ ~/.config/saxby/config.json is not valid JSON or JSONC:
Cannot parse JSONC: unexpected end of JSONC input
```

A syntax error, often a missing brace or a stray comma. JSONC allows
comments; it does not forgive broken structure.

```
❌ Invalid config in ~/.config/saxby/config.jsonc:
- unknown field 'listen_prot' — check the spelling
```

Every problem is listed at once, each with its path. Unknown fields
are errors on purpose, so a typo cannot be silently ignored. A model
named anywhere — `global_default_model`, a persona's
`default_model`, `semantic.active` — must exist in the catalog. See
[Configuration](configuration.md).

###  The port is taken

```
❌ Port 11435 is already in use.
   Another saxbyd is already serving the default instance (pid 13995).
   Usual cause: a second supervisor — brew services, saxby service, or a terminal run left open.
```

Two copies of the same instance. The usual culprit is a terminal run
left open while the service is installed, or both `brew services`
and `saxby service` running it. Stop one. The pid says which process
to stop.

If the message names a **different** instance, two instances share a
`listen_port`; change one. If it says the holder **is not saxbyd**,
something else owns the port; change `listen_port` in the folder the
message names.

Under the service, a refused start retries every few seconds, so the
message repeats in the log until the clash is fixed. That is
deliberate.

##  Saxby starts, with warnings

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
harmless; [Releasing](releasing.md) explains why.

##  Requests fail

###  400, unmet_requirement

```
No model in this Saxby catalog claims TAG_VISION, so nothing here can handle images. Add TAG_VISION to the capabilities of a model that can.
```

The request has an image or audio, and no catalog model claims it can
handle that. If one of your models can, add the tag to its
`capabilities`. If none can, the refusal is correct.

###  400, too large for every model

```
No model in this Saxby catalog fits a request of about 1500000 tokens. The largest context window in the catalog is 393216.
```

The whole conversation is bigger than any model's `max_context`.
Start a new conversation, or have the client trim history.

###  502, upstream unreachable

```
Saxby could not reach its upstream at http://127.0.0.1:11434: fetch failed
```

Saxby is fine; the backend is not answering. Check that Ollama is
running and that `upstream_url` is right.

##  Requests are refused (403)

Saxby checks no credentials, so it serves only clients on the same
machine and refuses anything that looks otherwise. Each refusal is
logged as a line starting with `🚫`, with its reason and source.

###  proxy_attribution_required

```
Refused: the request carries 'x-forwarded-for', so it came through a proxy. Saxby only serves clients on this machine directly.
```

A reverse proxy — Caddy, nginx, `tailscale serve` — is passing
requests to Saxby. On the same machine, every proxied request looks
local, including ones from strangers, so Saxby refuses them. Point
the client at `127.0.0.1:11435` directly instead of through the
proxy. Serving through a proxy needs per-client keys, planned after
v1.

###  origin_not_allowed

```
Refused: the request came from a web page (Origin 'https://evil.example'). Saxby does not serve browsers.
```

A web page in a browser tried to call Saxby. Any site you visit can
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
networking; see [Clients](clients.md).

###  management_not_allowed

```
Refused: '/api/pull' manages Ollama's models and is not served through Saxby. Call Ollama directly.
```

Pulling, pushing, creating, copying and deleting models are Ollama's
job, not a router's. Run `ollama pull` or call Ollama on port 11434.

###  Another machine cannot connect

Saxby listens on `127.0.0.1` only, so nothing beyond this machine
can reach it. That is deliberate until per-client keys exist, after
v1.

##  Requests go to the wrong model

Start with `explain`. It shows the tags, the tier, and why every tier
that declined, declined — without generating anything:

```bash
curl -s http://127.0.0.1:11435/saxby/v1/explain \
    -H "Content-Type: application/json" \
    -d '{"model": "saxby", "messages": [{"role": "user",
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
not lower the threshold. `saxby probe` checks many prompts at once.

**Requests go to a small model for no reason.** The request probably
sets `stream: false`, which marks it as background work. Many SDKs do
this. See "Background requests" in [Routing](routing.md).

**A model is skipped.** `skipped` in the `explain` output says why,
usually that the conversation does not fit its `max_context`.

##  The service

###  install refuses

```
❌ No 'saxbyd' on PATH. Deploy a build first (docs/releasing.md) or pass --bin <path>.
```

The service runs a compiled binary. Build and install one first, as
[Releasing](releasing.md) describes.

```
❌ :11435 is already served by the default instance (pid 80797) outside this service. Stop it first.
```

A saxbyd started by hand — usually a terminal run of the source as
the default instance — already holds the port. Stop it, then install.
`deno task dev` runs the dev instance on its own port, so it never
blocks this.

```
❌ :11435 is held by a process that is not saxbyd. Stop it, or change listen_port in ~/.config/saxby.
```

Another program owns the port. Stop it, or give this instance a
different `listen_port`.

```
❌ systemd --user is not available in this session: ...
```

Linux only. There is no user service manager here, which is common
in containers and some minimal installs.

###  restart says nothing is loaded

```
❌ tools.saxby.router is installed but not loaded, so there is nothing to restart. Run 'saxby service install' to load it.
```

macOS only. The service file exists, but launchd is not running it.
Run `saxby service install`, which loads it again.

Before v0.9.3, a reinstall could end this way, with `Bootstrap failed:
5: Input/output error`. The old service was still shutting down when
the new one tried to load. Install now waits for it.

###  The service stopped when I logged out

Linux only. User services stop at logout unless lingering is on for
your user:

```bash
loginctl enable-linger
```

###  Where the logs are

| Platform | Logs |
| --- | --- |
| macOS | `~/Library/Logs/saxby/tools.saxby.router.out.log` and `.error.log` |
| Linux | `journalctl --user -u saxbyd` |

Warnings print to the error log on macOS.

###  It is running an old build

`saxby instance list` shows each instance's version. Code changes
reach the service on your machine only after a deploy. From a
checkout, `deno task deploy` builds, installs, restarts and checks
the version in one step. See [Releasing](releasing.md).

If the deploy says the service reports an older version than it
built, the service file points at a `saxbyd` in another folder. Run
`saxby service install` to point it at the one on `PATH`.

##  Instances

```
❌ Invalid instance name 'Dev': use lowercase letters, digits and hyphens, starting with a letter or digit.
```

```
ℹ️  'default' is reserved for the default instance. Using ~/.config/saxby.
```

Not an error: `-i default` and `SAXBY_INSTANCE=default` select the
default instance, and the note says which folder that is.

See [Instances](instances.md) for naming. A **blocked** state in
`instance list` means something else holds this one's port: another
instance, or a program that is not saxbyd. The line under the table
says which.

##  The shell and the system

**"zsh: correct 'saxby' to 'shout'".** zsh has not noticed the new
command yet. Run `rehash`, or open a new terminal.

**"Background Items Added".** macOS shows this the first time a
service is installed. It is expected.

**A downloaded binary will not open on macOS.** Release binaries are not
signed yet, so Gatekeeper blocks them when the archive came through a
browser. [Issue #7](https://github.com/saxby-tools/saxby/issues/7)
tracks signing. Until then, clear the quarantine flag yourself, only on
a download you trust:

```bash
xattr -d com.apple.quarantine saxbyd saxby
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

Search the [open issues](https://github.com/saxby-tools/saxby/issues),
including the `known-gap` label, which lists every known limitation.
Open a new issue with the `explain` output for a routing problem, or
the log lines for anything else.
