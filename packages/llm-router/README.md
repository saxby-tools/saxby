# @saxby/llm-router

`saxbyd`, the daemon of
[Saxby](https://github.com/saxby-tools/saxby). It sits in front of an
OpenAI-compatible backend such as Ollama, listens on `:11435`, and
routes each chat request to the right local model: code to your
coding model, a photo to a model that can see, a quick question to a
fast one. Every decision is logged with its reasons. The
command-line tool that configures it is `@saxby/cli`.

## Install

With Deno 2.9 or newer. The daemon may start only the programs the
memory broker needs, each by its full path.

```bash
deno install -g -n saxbyd \
    --allow-net --allow-env --allow-read --allow-write \
    --allow-run=/bin/kill,/usr/sbin/sysctl,/usr/bin/vm_stat \
    jsr:@saxby/llm-router
```

On Linux, use `--allow-run=/usr/bin/kill` instead. Release binaries,
a Homebrew tap, an AUR package and a Docker image are listed in
[Getting started](https://github.com/saxby-tools/saxby/blob/main/docs/getting-started.md).

## Example

Run the daemon, then ask it how it would route a request. The explain
route returns the full decision as JSON and never calls the backend,
so it loads no model.

```bash
saxbyd --trace
```

```bash
curl -s http://127.0.0.1:11435/saxby/v1/explain \
    -H 'Content-Type: application/json' \
    -d '{"model":"saxby","messages":[{"role":"user",
         "content":"Refactor this function to remove the nested loop"}]}'
```

Point your apps at `http://127.0.0.1:11435/v1` with the model
`saxby`, or at `saxby/<model>` to bypass routing.

## Options

```
Usage: saxbyd [options]

Options:
  -i, --instance <name>  Serve a named instance, not the default instance.
  -v, --verbose          Print each request's lifecycle.
      --trace            Verbose, plus why each routing tier declined.
  -V, --version          Print the version and exit.
  -h, --help             Print this help and exit.
```

## Documentation

- [Routing](https://github.com/saxby-tools/saxby/blob/main/docs/routing.md)
- [Configuration](https://github.com/saxby-tools/saxby/blob/main/docs/configuration.md)
- [Clients](https://github.com/saxby-tools/saxby/blob/main/docs/clients.md)
- [Memory broker](https://github.com/saxby-tools/saxby/blob/main/docs/memory-broker.md)
- [Architecture](https://github.com/saxby-tools/saxby/blob/main/docs/architecture.md)

## License

AGPL-3.0-or-later.
