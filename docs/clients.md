#  Clients

Anything that speaks the OpenAI chat API can use Saxby. Point it at
Saxby instead of your backend, and ask for the model `saxby`.

##  The three settings every client needs

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API key | anything non-empty |
| Model | `saxby` |

Saxby does not check the API key. It passes the `Authorization`
header on to the backend, and Ollama ignores it, but many clients
refuse to start without one. Clients are told apart by their
`User-Agent`, never by their key.

Because nothing is checked, Saxby only serves clients on the same
machine. It listens on `127.0.0.1` only, and it refuses requests that
came through a proxy, came from a web page, or name a host other than
`localhost`, `127.0.0.1`, `[::1]` or `host.docker.internal`. Each
refusal is a 403 explained in [Troubleshooting](troubleshooting.md). Serving
other machines needs per-client keys, which are planned after v1.

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
