# @saxby/cli

`saxby`, the command-line tool for
[Saxby](https://github.com/saxby-tools/saxby), a local-first LLM
routing daemon. It generates the config, installs the daemon as a
service, reserves GPU memory for a job and shows what the daemon is
doing. The daemon itself is `@saxby/llm-router`.

##  Install

With Deno 2.9 or newer. The flags give the program the same
permissions the release binaries have.

```bash
deno install -g -n saxby \
    --allow-net --allow-env --allow-read --allow-write \
    --allow-run --allow-sys=uid jsr:@saxby/cli
```

Release binaries, a Homebrew tap, an AUR package and a Docker image
are listed in
[Getting started](https://github.com/saxby-tools/saxby/blob/main/docs/getting-started.md).

##  Example

Write a config from the models your backend has, then run the daemon
as a service.

```bash
saxby config generate
saxby service install
saxby status
```

Then point your apps at `http://127.0.0.1:11435/v1` with the model
`saxby`.

##  Commands

| Command | Does |
| ------- | ---- |
| `config generate` | Writes `config.jsonc` from the backend's models |
| `instance list` | Lists instances with their ports and whether they run |
| `probe` | Scores prompts against Tier 3 exemplars, generating nothing |
| `reserve --gib N -- <command>` | Runs a job once GPU memory is reserved |
| `service install\|uninstall\|status\|restart` | Runs Saxby as a user service |
| `status` | Says whether this instance's daemon is answering |
| `token` | Prints the API token, or replaces it |
| `vram-guard-mac` | The Apple Silicon memory ceiling daemon |

Every command takes `-i <name>` to target a named instance.

##  Documentation

- [Getting started](https://github.com/saxby-tools/saxby/blob/main/docs/getting-started.md)
- [Configuration](https://github.com/saxby-tools/saxby/blob/main/docs/configuration.md)
- [Services](https://github.com/saxby-tools/saxby/blob/main/docs/services.md)
- [Memory broker](https://github.com/saxby-tools/saxby/blob/main/docs/memory-broker.md)

##  License

AGPL-3.0-or-later.
