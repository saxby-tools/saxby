#  Docker

`saxbytools/saxby` holds the same `saxbyd` and `saxby` a release
tarball carries, on a base image with nothing else in it. It is for
Linux hosts and for Compose stacks. On a Mac, the Homebrew package is
the better install: Docker there runs a Linux VM, and the VRAM guard
and the memory broker are features of a native install.

The image holds no backend. Saxby routes to an OpenAI-compatible
server you run yourself, such as Ollama.

##  What is in the image

| Thing | Value |
| --- | --- |
| Binaries | `/usr/local/bin/saxbyd` (the entrypoint) and `/usr/local/bin/saxby` |
| User | `nonroot`, uid 65532 |
| Data | `/data`, one volume: config, decision log, vectors and API token, in `/data/saxby` |
| Port | 11435 |
| Health check | `saxby status` |
| Platforms | `linux/amd64`, `linux/arm64` |

There is no shell in the image. Run the CLI by naming it as the
entrypoint, or with `docker exec` once Saxby is up, as below.

The examples use the tag `0.9`, which follows the newest 0.9 release.
There is no `latest` yet, so a pull with no tag fails; see
[Tags](#tags).

##  The one thing to know first

Saxby asks nothing of a client on its own machine and the API token
of every other; see [The API token](configuration.md#the-api-token).
Inside a container, "its own machine" is the container. A request
from the host through a published port, or from the next container
over, arrives from another address. So **every client of a
containerized Saxby needs the token**, and reaches
`/v1/chat/completions` and `/v1/models` only.

That is the right default for a container. `-p 11435:11435` with no
address publishes to every interface on the host, and a Compose
network is shared by every service on it. The token is what stands
between those and your models.

##  First run

A container's own loopback cannot be reached from outside it, so in
a container Saxby must listen on every interface. That is one flag
at config time.

1. Write a config into the volume. This asks which models to use, so
   it needs `-it` and a backend that is already running. `--host` is
   that backend's address as the container sees it:

   ```bash
   docker run --rm -it -v saxby-data:/data --entrypoint saxby saxbytools/saxby:0.9 config generate --listen-host 0.0.0.0 --host http://ollama:11434
   ```

2. Start Saxby. Publish the port to the host's loopback, not to
   every interface:

   ```bash
   docker run -d --name saxby -v saxby-data:/data -p 127.0.0.1:11435:11435 saxbytools/saxby:0.9
   ```

3. Read the API token:

   ```bash
   docker exec saxby saxby token
   ```

Then point a client at `http://127.0.0.1:11435/v1` with that token as
its API key, and ask for the model `saxby`.

If the container starts and the port does not answer, the config was
written without `--listen-host 0.0.0.0`. Saxby says so in its log;
see "A container's published port does not answer" in
[Troubleshooting](troubleshooting.md).

##  Compose

A client in another container reaches Saxby by its service name and
sends that name as `Host`. Saxby refuses names it was not told about,
so list the service name in `allowed_hosts`:

```bash
docker compose run --rm --entrypoint saxby saxby config generate --listen-host 0.0.0.0 --allowed-hosts saxby --host http://ollama:11434
```

```yaml
services:
    ollama:
        image: ollama/ollama
        volumes:
            - ollama-data:/root/.ollama
        restart: unless-stopped

    saxby:
        image: saxbytools/saxby:0.9
        volumes:
            - saxby-data:/data
        ports:
            - "127.0.0.1:11435:11435"
        depends_on:
            - ollama
        restart: unless-stopped

volumes:
    ollama-data:
    saxby-data:
```

Start `ollama` and pull your models before the `config generate`
step above, since it reads them from the backend.

Clients on the same Compose network use `http://saxby:11435/v1` and
the token. For Open WebUI that is `OPENAI_API_BASE_URL` and
`OPENAI_API_KEY`.

##  Reaching a backend on the host

`http://127.0.0.1:11434` inside a container is the container itself.
If Ollama runs on the host and not in the stack:

- **Docker Desktop:** use `http://host.docker.internal:11434`.
- **Linux, host network:** the simplest setup is `--network host`.
  The container then shares the host's loopback: leave
  `--listen-host` out, publish no port, and Saxby behaves as a
  native install does. Local clients need no token.
- **Linux, bridge network:** add
  `extra_hosts: ["host.docker.internal:host-gateway"]` to the Saxby
  service and use `http://host.docker.internal:11434`. Ollama must
  then listen on an address the container can reach, which its
  default, `127.0.0.1`, is not; see `OLLAMA_HOST` in Ollama's docs.

##  Editing the config

A saved config is applied live in a container too; see
[Edits apply on save](configuration.md#edits-apply-on-save). Both
ways of keeping `/data` were checked on Docker Desktop for macOS
(Engine 29.9.2) on Nov. 9, 2026: a named volume edited from another
container or with `docker cp`, and a folder bind-mounted from the
Mac and edited there.

The image's health check is `saxby status`, which reads the config
file. While the file is broken, the container is reported unhealthy
even though saxbyd keeps serving the config it had. That is a fair
warning: the container would not survive a restart. Docker itself
does not restart an unhealthy container.

##  What does not work in a container

- **`saxby reserve`.** The memory broker checks that a job's process
  is alive, and a container cannot see the host's processes. A
  reservation is refused, and says why. Chat requests are not
  affected.
- **`saxby service`.** Docker is the supervisor; use a restart
  policy.
- **`saxby vram-guard-mac`.** It sets a macOS kernel setting.
- **`/v1/embeddings` and Ollama's own API from another container.**
  They are not among the routes another machine may reach.

##  Tags

`X.Y.Z` is one release and never moves. `X.Y` follows the newest
patch release. There is no `latest` until v1.0.0.

##  Building it yourself

```bash
deno task build linux-arm64
```

```bash
deno task docker-context
```

```bash
docker build -f packaging/Dockerfile -t saxby:local dist/docker
```

Use `linux-x64` on an Intel or AMD machine. The second command lays
out `dist/docker/` from the build and prints the platforms it found.
