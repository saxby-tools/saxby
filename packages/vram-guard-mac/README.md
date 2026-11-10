# @saxby/vram-guard-mac

The Apple Silicon GPU memory ceiling daemon of
[Saxby](https://github.com/saxby-tools/saxby), shipped as the
`saxby vram-guard-mac` subcommand. macOS only, on purpose: it changes
a macOS-only setting while the machine runs, and the router it ships
with stays platform-agnostic.

A LaunchDaemon sets `iogpu.wired_limit_mb` once, at boot, then exits.
The ceiling is a maximum, not a reservation: raising it takes nothing
from macOS until a model is loaded. Backends such as Ollama read it
once, when they start, so a daemon that runs before anyone logs in
means a backend started at login reads the raised value with no
restart. The script knows nothing about any backend.

##  Install

The command comes with `@saxby/cli`; install that package and the
subcommand is there.

```bash
deno install -g -n saxby \
    --allow-net --allow-env --allow-read --allow-write \
    --allow-run --allow-sys=uid jsr:@saxby/cli
```

##  Example

Install the LaunchDaemon, check it, remove it. Each step asks for
administrator rights, since the daemon lives under `/Library`.

```bash
saxby vram-guard-mac install
saxby vram-guard-mac status
saxby vram-guard-mac uninstall
```

The default ceiling is 86% of RAM. An optional override file at
`/usr/local/etc/saxby/vram-guard-mac.env` sets `VRAM_GUARD_LIMIT_MB`
to raise or lower it; a lower ceiling keeps memory a runaway GPU job
can never wire. The script sources that file as root, so it refuses
one that root does not own or that anyone else can write. Uninstall
leaves the file in place.

##  Use from code

The export is one cliffy command, for a program that wants to mount
it under its own name.

```js
import { Command } from "@cliffy/command";
import { vramGuardMacCommand } from "@saxby/vram-guard-mac";

await new Command()
    .command("vram-guard-mac", vramGuardMacCommand)
    .parse(Deno.args);
```

##  Documentation

- [Memory broker](https://github.com/saxby-tools/saxby/blob/main/docs/memory-broker.md)
- [Services](https://github.com/saxby-tools/saxby/blob/main/docs/services.md)

##  License

AGPL-3.0-or-later.
