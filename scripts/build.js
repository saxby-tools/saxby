//  =====================================================================
//  deno task build
//  =====================================================================
//  Cross-compiles shuntd and shunt, then packs one tarball per target
//  with a .sha256 beside it:
//
//    dist/shuntd-<version>-<target>/          staged, ready to promote
//    dist/shuntd-<version>-<target>.tar.gz
//    dist/shuntd-<version>-<target>.tar.gz.sha256
//
//  Pass target names to build only those (`deno task build
//  darwin-arm64`) — one native build is what a local promotion needs.
//
//  Permissions are baked in explicitly rather than -A. The daemon
//  faces the network and never starts a process, so it gets no
//  --allow-run: a bug in request handling cannot launch a program.
//  The CLI runs osascript, launchctl and sysctl, so it does.
//
//  `deno compile` IGNORES the "unstable" list in deno.json, and an
//  explicit --unstable-no-legacy-abort is accepted but has no effect
//  in the binary (Deno 2.9.6). Compiled binaries therefore run with
//  legacy request.signal semantics. See docs/releasing.md.

import { basename, join } from "@std/path";

const DIST_DIR = "dist";
const ARCHIVE_PREFIX = "shuntd";

//  Packages are versioned in lockstep; the build refuses to run if
//  they disagree, so a release can never ship mixed versions.
const PACKAGE_MANIFESTS = [
    "packages/cli/deno.json",
    "packages/core/deno.json",
    "packages/llm-router/deno.json",
    "packages/vram-mac-guard/deno.json",
];

const TARGETS = [
    { name: "darwin-arm64", triple: "aarch64-apple-darwin" },
    { name: "darwin-x64", triple: "x86_64-apple-darwin" },
    { name: "linux-x64", triple: "x86_64-unknown-linux-gnu" },
    { name: "linux-arm64", triple: "aarch64-unknown-linux-gnu" },
];

const BINARIES = [
    {
        name: "shuntd",
        entry: "packages/llm-router/src/main.js",
        permissions: [
            "--allow-net",
            "--allow-env",
            "--allow-read",
            "--allow-write",
        ],
        include: [],
    },
    {
        name: "shunt",
        entry: "packages/cli/src/main.js",
        permissions: [
            "--allow-net",
            "--allow-env",
            "--allow-read",
            "--allow-write",
            "--allow-run",
        ],
        include: ["packages/vram-mac-guard/src/vram-mac-guard.sh"],
    },
];

const EXTRA_FILES = ["LICENSE", "README.md"];

async function readLockstepVersion() {
    const versions = new Map();

    for (const path of PACKAGE_MANIFESTS) {
        const manifest = JSON.parse(await Deno.readTextFile(path));
        versions.set(path, manifest.version);
    }

    const distinct = new Set(versions.values());

    if (distinct.size !== 1) {
        const listing = [...versions]
            .map(([path, version]) => `  ${path}: ${version}`)
            .join("\n");

        throw new Error(`Package versions disagree:\n${listing}`);
    }

    return [...distinct][0];
}

function selectTargets(names) {
    if (names.length === 0) {
        return TARGETS;
    }

    const known = new Set(TARGETS.map((target) => target.name));

    for (const name of names) {
        if (!known.has(name)) {
            throw new Error(
                `Unknown target '${name}'. Known: ${[...known].join(", ")}`,
            );
        }
    }

    return TARGETS.filter((target) => names.includes(target.name));
}

async function run(command, args, env = {}) {
    const child = new Deno.Command(command, {
        args,
        env,
        stdout: "inherit",
        stderr: "inherit",
    });

    const { code } = await child.output();

    if (code !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited ${code}`);
    }
}

async function compile(binary, target, outDir) {
    const includes = binary.include.flatMap((path) => ["--include", path]);

    await run("deno", [
        "compile",
        "--quiet",
        "--target",
        target.triple,
        ...binary.permissions,
        ...includes,
        "--output",
        join(outDir, binary.name),
        binary.entry,
    ]);
}

async function sha256Hex(path) {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

//  Same line format as `shasum -a 256` and `sha256sum`, so either
//  tool can check it with -c from inside dist/.
async function writeChecksum(archivePath) {
    const hex = await sha256Hex(archivePath);
    const line = `${hex}  ${basename(archivePath)}\n`;

    await Deno.writeTextFile(`${archivePath}.sha256`, line);
}

//  --no-xattrs plus COPYFILE_DISABLE keep macOS metadata (._ files,
//  quarantine attributes) out of an archive Linux will unpack.
async function pack(stageName) {
    const archivePath = join(DIST_DIR, `${stageName}.tar.gz`);

    await run(
        "tar",
        ["--no-xattrs", "-czf", archivePath, "-C", DIST_DIR, stageName],
        { COPYFILE_DISABLE: "1" },
    );

    await writeChecksum(archivePath);

    return archivePath;
}

async function buildTarget(target, version) {
    const stageName = `${ARCHIVE_PREFIX}-${version}-${target.name}`;
    const stageDir = join(DIST_DIR, stageName);

    await Deno.mkdir(stageDir, { recursive: true });

    for (const binary of BINARIES) {
        console.log(`🔨 ${target.name}: ${binary.name}`);
        await compile(binary, target, stageDir);
    }

    for (const file of EXTRA_FILES) {
        await Deno.copyFile(file, join(stageDir, file));
    }

    const archivePath = await pack(stageName);

    console.log(`📦 ${archivePath}`);
}

async function main() {
    const version = await readLockstepVersion();
    const targets = selectTargets(Deno.args);

    await Deno.remove(DIST_DIR, { recursive: true }).catch(() => {});
    await Deno.mkdir(DIST_DIR);

    console.log(`shuntd ${version}, ${targets.length} target(s)\n`);

    for (const target of targets) {
        await buildTarget(target, version);
    }
}

if (import.meta.main) {
    await main();
}
