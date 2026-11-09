#  Clients

Anything that speaks the OpenAI chat API can use Saxby. Point it at
Saxby instead of your backend, and ask for the model `saxby`.

##  The three settings every client needs

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API key | anything non-empty, on the same machine |
| Model | `saxby` |

On the same machine, Saxby does not check the API key. It passes the
`Authorization` header on to the backend, and Ollama ignores it, but
many clients refuse to start without one. Clients are told apart by
their `User-Agent`, never by their key.

A client on another machine is different: its API key must be
Saxby's API token. Print it on the machine running Saxby:

```bash
saxby token
```

See [The API token](configuration.md#the-api-token).

Saxby listens on `127.0.0.1` only, and it refuses requests that came
from a web page or name a host other than `localhost`, `127.0.0.1`,
`[::1]` or `host.docker.internal`. Each refusal is explained in
[Troubleshooting](troubleshooting.md). The way in from another
machine is your own tailnet; see
[A phone keyboard over Tailscale](#a-phone-keyboard-over-tailscale).
A browser extension you choose can be let in too; see
[A browser extension](#a-browser-extension).

Use `saxby/<model>` to skip routing and reach one model directly.
See [Routing](routing.md).

##  Open WebUI

These settings were checked against Open WebUI v0.12.0 running in
Docker.

###  Connecting

Set the connection in the container's environment:

```
OPENAI_API_BASE_URL=http://host.docker.internal:11435/v1
OPENAI_API_KEY=saxby
ENABLE_OLLAMA_API=false
```

`host.docker.internal` is how a container reaches your machine.
Saxby listens only on `127.0.0.1`, and Docker Desktop on macOS
routes `host.docker.internal` to the host's loopback, so this works
as is.

**On Linux**, a container cannot reach the host's loopback through
Docker's bridge network. Run Open WebUI with host networking
(`--network host`, or `network_mode: host` in Compose) and point it
at loopback directly:

```
OPENAI_API_BASE_URL=http://127.0.0.1:11435/v1
HOST=127.0.0.1
```

`HOST=127.0.0.1` keeps Open WebUI's own port (8080, under host
networking) on loopback too. Without it, host networking puts Open
WebUI on every network interface. That is Open WebUI's exposure, not
Saxby's, but it is fixed in the same place. Podman's
`host.containers.internal` is not accepted; use host networking there
as well.

**Turn off Open WebUI's own Ollama connection** with
`ENABLE_OLLAMA_API=false`. Otherwise Open WebUI talks to Ollama
directly as well, and every request it sends that way skips routing
and never reaches the decision log.

The same connection can be added in the admin panel under Settings,
Connections, instead of the environment.

###  The task model

Open WebUI generates chat titles, tags and follow-up questions in the
background. It sends those requests to a **task model**: the External
Task Model in the admin panel's Settings, Interface, when one is set,
and otherwise the same model the chat uses.

Set the **External Task Model to `saxby`**. If a chat uses `saxby`,
background work is routed either way. But if someone picks
`saxby/gemma4:31b` to talk to one model directly, an unset task model
sends every title request to that large model too.

Open WebUI sends this background work with `stream: false`, which
Saxby routes to the model claiming `TAG_BACKGROUND` — a small, fast
one, ideally. See [Configuration](configuration.md).

###  Telling Open WebUI apart in the log

With default settings, Open WebUI's requests carry the `User-Agent`
of its HTTP library, so the decision log calls it `python`. To have it
logged as `open-webui`, set:

```
ENABLE_FORWARD_USER_INFO_HEADERS=true
```

That makes Open WebUI send each user's name, id, email and role as
headers. Saxby only checks that the headers are present and never
stores their values. On chat requests it does not pass them on to the
backend. Requests Saxby does not route itself — embeddings, for example
— are passed through with their headers intact, so if Open WebUI embeds
through Saxby, the backend sees them.
[Issue #22](https://github.com/saxby-tools/saxby/issues/22) tracks
whether Saxby should strip them. Whether that is worth it is your call;
without it, everything still works and the client is simply logged as
`python`.

If you also set `FORWARD_USER_INFO_HEADER_JWT_SECRET`, Open WebUI
sends one signed `X-OpenWebUI-User-Jwt` header instead, which Saxby
also recognizes. If you rename these headers with the
`FORWARD_USER_INFO_HEADER_*` variables, Saxby will not recognize
them.

###  A second connection for the dev instance

To try the dev instance from the same Open WebUI, add a second
connection to `http://host.docker.internal:11436/v1` — the dev
instance from `deno task dev` — and give it the Prefix ID `dev`. Its
models appear as `dev.saxby` and `dev.saxby/<model>` beside the real
ones. Open WebUI removes the prefix before the request reaches Saxby.
See [Instances](instances.md) for the dev instance.

##  OpenClaw

OpenClaw takes Saxby as a custom provider in `openclaw.json`:

```json
{
    "models": {
        "providers": {
            "saxby": {
                "baseUrl": "http://127.0.0.1:11435/v1",
                "api": "openai-completions",
                "apiKey": "saxby",
                "models": [
                    {
                        "id": "saxby",
                        "name": "saxby",
                        "contextWindow": 128000,
                        "input": ["text", "image", "audio"]
                    }
                ]
            }
        }
    },
    "agents": {
        "defaults": {
            "model": { "primary": "saxby/saxby" }
        }
    }
}
```

`saxby/saxby` is OpenClaw's own `provider/model` naming: the
provider called `saxby`, its model `saxby`. It is not Saxby's
`saxby/<model>` bypass, which would skip routing.

List `image` and `audio` under `input` only if your catalog has
models that claim `TAG_VISION` and `TAG_AUDIO`. Otherwise OpenClaw
offers attachments that Saxby will refuse.

OpenClaw sizes conversations against `contextWindow`. Saxby checks
each request against the chosen model's `max_context` and moves on to
a bigger model when one is too small. A window larger than your
smallest models means long conversations get rerouted, and refused
only when no model in the catalog fits.

OpenClaw uses the OpenAI JavaScript SDK, so the decision log calls it
`openai`. To name it, add this to Saxby's config:

```json
"client_names": { "openai": "openclaw" }
```

Any other client built on the same SDK gets the same name — on one
machine, OpenClaw and another app both logged as `openai`, so this
mapping would mislabel the other one.
[Issue #21](https://github.com/saxby-tools/saxby/issues/21) tracks a way
to tell them apart.

OpenClaw's memory search can embed text through Ollama directly.
Those calls do not pass through Saxby and are not logged.

##  A phone keyboard over Tailscale

A phone is not on the same machine, so it needs the one way in: a
proxy you name in `trusted_proxies`. This example is
[LeanType](https://github.com/LeanBitLab/LeanType), an Android
keyboard that sends text to an OpenAI-compatible endpoint for
proofreading and translation.

###  Connecting

1. Publish Saxby to your tailnet and name the proxy in the config.
   Both steps are in
   [Trusted proxies](configuration.md#trusted-proxies).
2. In LeanType's AI settings:

| Setting | Value |
| --- | --- |
| AI Provider | HF/OpenAI-compatible |
| Model | `saxby` |
| API Endpoint | `https://my-mac.my-tailnet.ts.net:11435/v1/chat/completions` |
| API Token | the output of `saxby token` |

The phone is another machine, so the token is checked. Run
`saxby token` on the machine running Saxby and paste the result.

###  Turning reasoning off

LeanType's request is fixed: a model, one user message holding its
instruction and your text, a temperature and a token limit. A model
that reasons by default will reason over every sentence, and on the
reference setup one grammar fix took 13 seconds that way. LeanType
has no setting that sends `reasoning_effort` (its source, read Nov.
8, 2026), so set it for the client:

```jsonc
"client_defaults": {
    "leantype": { "reasoning_effort": "none" }
}
```

The same fixes then took about a second. See
[Client defaults](configuration.md#client-defaults).

###  Two things to know

- **Its text is stored if `log_prompts` is on.** A keyboard sends
  whatever you select in any app. With `log_prompts` set to `true`,
  each piece lands in the decision log as plain text. See
  [Logging](configuration.md#logging).
- **A small model may be the wrong saving.** Asking for
  `saxby/<small-model>` is faster still. On the reference setup a 3B
  model failed the first test sentence, while the 31B model with
  reasoning off got every one right.

LeanType leaves `stream` unset, so it is not routed as background
work; that rule needs an explicit `stream: false`. On the reference
setup its requests matched no tier and reached the global default
model.

##  A browser extension

An extension runs inside your browser, and Saxby refuses browsers.
You can let one in by its exact origin. This example is
[grammer-check](https://github.com/Mangesh-P/grammer-check), a
grammar checker that calls an OpenAI-compatible endpoint.

1. In the extension, choose its local-model option, set the base
   URL to `http://127.0.0.1:11435/v1` and the model to `saxby`. From
   another machine on your tailnet, use the address from
   [Trusted proxies](configuration.md#trusted-proxies) instead, and
   set the API key to the output of `saxby token`.
2. Let it check something once. It fails with a 403 that names its
   origin.
3. Add that origin to `allowed_origins`, as
   [Browser extensions](configuration.md#browser-extensions) shows,
   and restart Saxby.

This extension checks on every pause in typing and sends no
`reasoning_effort` to a local endpoint (its source, read Nov. 8,
2026). With a model that reasons by default, give it a
`client_defaults` entry under its `ext-<id>` signature, or every
pause costs a full round of reasoning.

As with a keyboard, what it sends is stored if `log_prompts` is on:
here that is the text of whatever field you are typing in.

##  Scripts and SDKs

`curl`, the OpenAI SDKs and your own scripts work with the three
settings above. Two things to know:

- A request with `stream: false` is routed as background work. Most SDKs
  can send non-streaming requests, so a script that does will land on
  your background model. Set `route_background_tasks` to `false` if that
  is wrong for you.
  [Issue #1](https://github.com/saxby-tools/saxby/issues/1) tracks a
  better rule.
- The log names a script by the first word of its `User-Agent`:
  `python`, `node`, `curl`, `openai`. Use `client_names` to tell them
  apart.

##  Where else your chats are stored

Saxby keeps prompt text out of its own log unless you turn it on; see
[Logging](configuration.md#logging). The tools in front of Saxby keep
their own copies, and Saxby cannot do anything about those.

**Open WebUI** stores every chat in its own database, unencrypted by
default. Its page [Chat Data Privacy &
Encryption](https://docs.openwebui.com/security/chat-data-privacy-and-encryption)
says what it keeps and how to protect it; the short version is that
encryption is the job of the database or the filesystem under it.

**OpenClaw** keeps each agent's conversations on disk as transcripts,
by default under `~/.openclaw/agents/<agent>/sessions/`, and its
`transcripts` tool writes more under `~/.openclaw/transcripts/`. See
its [transcripts](https://docs.openclaw.ai/cli/transcripts) and
[session management](https://docs.openclaw.ai/reference/session-management-compaction)
pages.

A client's own history is that client's to protect. Check each
tool's docs before giving other people an account on it.

##  Who owns what

When one AI tool sits in front of another — Open WebUI in front of an
agent, an agent in front of Saxby — each layer should own its own
decisions and leave the rest alone.

Saxby owns **which model** answers. A client that picks a specific
model, or swaps models on its own schedule, is making that decision
twice, and the two will disagree. Ask for `saxby` and let the router
decide.

The same goes the other way. When a chat UI sits in front of an
agent, every feature the UI also offers — its own memory, its own
system prompt, its own web search, its own title generation — is a
second opinion about something the agent already decided. Turn those
off in the outer layer and let the layer doing the work own them.
