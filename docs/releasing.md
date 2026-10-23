#  Releasing

The checklist for cutting a release and for promoting a local build
to production. It works by hand the first time and drifts silently by
the third, which is why it is written down.

##  Version

Every package carries the same version. Bump all four together in the
release commit:

```
packages/cli/deno.json
packages/core/deno.json
packages/llm-router/deno.json
packages/vram-mac-guard/deno.json
```

`deno task build` refuses to run if they disagree, so a mixed release
cannot ship. The running daemon reports its version at
`/shuntd/v1/status`, and `shunt instance list` shows it.

##  Build

```bash
deno task build
```

This compiles `shuntd` and `shunt` for four targets — darwin-arm64,
darwin-x64, linux-x64 and linux-arm64 — and writes each into
`dist/`:

```
dist/shuntd-<version>-<target>/                  staged binaries
dist/shuntd-<version>-<target>.tar.gz            LICENSE and README too
dist/shuntd-<version>-<target>.tar.gz.sha256
```

Name targets to build only those. One native build is all a local
promotion needs, and it takes a few seconds:

```bash
deno task build darwin-arm64
```

##  Verify

Check every archive against its checksum. On macOS:

```bash
cd dist && shasum -a 256 -c *.sha256
```

On Linux, use `sha256sum -c` instead. The line format is the same.

Then check that the native binary starts and reports the version you
expect. Run it against a dev instance, never production:

```bash
./dist/shuntd-<version>-darwin-arm64/shuntd --instance dev
```

```bash
curl -s http://127.0.0.1:11436/shuntd/v1/status
```

##  Promote a local build

Production binaries live in `~/.local/bin`, which is user-owned and on
`PATH` on both macOS and Arch. Promote with `install`, never `cp`:

```bash
install -m 755 dist/shuntd-<version>-darwin-arm64/{shuntd,shunt} ~/.local/bin/
```

`install` removes the old file and writes a new one, so the running
process keeps the old binary until it restarts. `cp` overwrites the
file the process is running from, which on macOS can get it killed
once its code signature no longer matches the pages on disk.

Then restart the service so it runs the new build:

```bash
shunt service restart
```

`shunt instance list` shows the version each running instance
reports, so a stale production binary is visible at a glance.

##  Release

Releases are built by `.github/workflows/release.yml` on a macOS
runner, never from a laptop, so every artifact comes from a clean
checkout of a tagged commit.

**Dry run first.** Push the release commit, then open the repository's
Actions tab, pick "release", and click "Run workflow". It runs the
tests, builds all four targets, verifies the checksums, renders the
packaging files, and uploads everything as a workflow artifact named
`shuntd-dry-run`. No tag, no release.

**Then tag.** The tag must match the package version, or the workflow
stops before building:

```bash
git tag -a v<version> -m "shuntd v<version>"
```

```bash
git push origin v<version>
```

The workflow opens a **draft** release with the four tarballs, their
`.sha256` files, and the rendered `PKGBUILD` and `shuntd.rb`. Read it
over, then click Publish. Nothing is public until then.

##  Packaging

The templates in `packaging/` are scaffolding, not maintained
repositories. None of them is edited by hand per release.

`PKGBUILD` (AUR `shuntd-bin`) and `shuntd.rb` (Homebrew) carry
`@VERSION@` and `@SHA256_<TARGET>@` tokens. `deno task package` fills
them from `dist/` after a full build, and refuses to write a file
with a token left in it. The workflow attaches the results to the
draft release.

`nfpm.yaml` builds `.deb` and `.rpm` packages and reads its version,
architecture and staged directory from the environment. Its header
shows the command. It is not run in CI.

##  Known caveats

**Compiled binaries run with legacy `request.signal` semantics.**
`deno compile` ignores the `unstable` list in `deno.json`, and an
explicit `--unstable-no-legacy-abort` is accepted but has no effect
in the binary (checked on Deno 2.9.6). Under legacy semantics the
signal also fires after a response has been fully delivered. In
`chat.js` that is after the upstream stream has ended, so it changes
nothing: a compiled binary and `deno run` produced the same decision
log rows for a completed stream and for a client that disconnected
mid-stream. The binary prints one warning about it at boot. Recheck
this when upgrading Deno, since the new behavior is meant to become
the default.

**macOS quarantines downloaded archives.** A tarball downloaded
through a browser gets a quarantine attribute, and Gatekeeper blocks
the unsigned binaries inside. Local builds are not affected. Signing
and notarization are not set up.
