# @saxby/core

Shared contracts for [Saxby](https://github.com/saxby-tools/saxby),
a local-first LLM routing daemon. `saxby config generate` writes a
config that `saxbyd` reads, and this package is the agreement
between them: the config schema and loader, instance folders, the
API token, backend adapters, memory probes, service labels and the
tag vocabulary.

Most people never import it. `@saxby/cli` and `@saxby/llm-router`
do, and anything that wants to read a Saxby config the way the
daemon does can too.

## Install

```bash
deno add jsr:@saxby/core
```

## Example

Load and validate the config of a named instance. The instance name
comes from the flag, then `SAXBY_INSTANCE`, then the default
instance.

```js
import { loadConfig, resolveInstanceName } from "@saxby/core";

const instance = resolveInstanceName("dev");
const config = await loadConfig(instance);

console.log(config.global_default_model);
```

A config that does not validate throws with every problem listed,
not just the first.

## What is in it

- `config/` — the schema (valibot), the loader, instance folders and
  the API token
- `backends/` — adapters for OpenAI-compatible backends; Ollama today
- `memory/` — GiB units and the probes that read a machine's memory
  ceiling and use
- `service/` — the `tools.saxby` service label prefix
- `tags/` — the tag vocabulary, validated in both directions at boot
- `utils/` — the config root, plist rendering, fetch errors and
  probing a host

## Documentation

- [Configuration](https://github.com/saxby-tools/saxby/blob/main/docs/configuration.md)
- [Instances](https://github.com/saxby-tools/saxby/blob/main/docs/instances.md)
- [Architecture](https://github.com/saxby-tools/saxby/blob/main/docs/architecture.md)

## License

AGPL-3.0-or-later.
