//  =====================================================================
//  deno task docker-context
//  =====================================================================
//  Lays out the Docker build context from the Linux builds already in
//  dist/, so the image holds the same binaries the release tarballs
//  do. Nothing is compiled here.
//
//    dist/saxby-<version>-linux-x64/     ->  dist/docker/linux/amd64/
//    dist/saxby-<version>-linux-arm64/   ->  dist/docker/linux/arm64/
//
//  Docker names platforms its own way, so packaging/Dockerfile copies
//  from ${TARGETOS}/${TARGETARCH}, and this is where the two namings
//  meet. In CI the staged folders come from the release's tarballs; on
//  a laptop, from `deno task build linux-arm64` or `linux-x64`.
//
//    deno task docker-context       lay out every Linux build found,
//                                   and print them as a --platform
//                                   list
//    deno task docker-context all   both platforms or fail — what CI
//                                   runs, so a release image cannot
//                                   quietly lack one

import { join } from "@std/path";
import { readLockstepVersion } from "./version.js";

const DIST_DIR = "dist";
const CONTEXT_DIR = join(DIST_DIR, "docker");
const ARCHIVE_PREFIX = "saxby";
const ALL_KEYWORD = "all";

const BINARIES = ["saxbyd", "saxby"];
const MODE_EXECUTABLE = 0o755;

//  target is the build's name for a platform; platform is Docker's.
const PLATFORMS = [
    { target: "linux-x64", platform: "linux/amd64" },
    { target: "linux-arm64", platform: "linux/arm64" },
];

async function exists(path) {
    try {
        await Deno.stat(path);
        return true;
    } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
            return false;
        }

        throw err;
    }
}

function stageDirFor(version, target) {
    return join(DIST_DIR, `${ARCHIVE_PREFIX}-${version}-${target}`);
}

async function isStaged(stageDir) {
    for (const binary of BINARIES) {
        if (!await exists(join(stageDir, binary))) {
            return false;
        }
    }

    return true;
}

async function layOut(stageDir, platform) {
    const outDir = join(CONTEXT_DIR, platform);

    await Deno.mkdir(outDir, { recursive: true });

    for (const binary of BINARIES) {
        const out = join(outDir, binary);

        await Deno.copyFile(join(stageDir, binary), out);
        await Deno.chmod(out, MODE_EXECUTABLE);
    }
}

async function main() {
    const wantAll = Deno.args[0] === ALL_KEYWORD;
    const version = await readLockstepVersion();

    //  A stale context would let yesterday's binary into today's image.
    if (await exists(CONTEXT_DIR)) {
        await Deno.remove(CONTEXT_DIR, { recursive: true });
    }

    const ready = [];
    const missing = [];

    for (const { target, platform } of PLATFORMS) {
        const stageDir = stageDirFor(version, target);

        if (!await isStaged(stageDir)) {
            missing.push(target);
            continue;
        }

        await layOut(stageDir, platform);
        ready.push(platform);
    }

    if (ready.length === 0) {
        throw new Error(
            `No Linux build of ${version} in ${DIST_DIR}/. Run ` +
                `'deno task build linux-arm64' or 'linux-x64' first.`,
        );
    }

    if (wantAll && missing.length > 0) {
        throw new Error(
            `Missing the ${missing.join(" and ")} build of ${version}. ` +
                `Run 'deno task build ${missing.join(" ")}' first.`,
        );
    }

    for (const target of missing) {
        console.error(`⏭️  ${target}: not built, left out of the context`);
    }

    console.error(`📦 ${CONTEXT_DIR}/ holds Saxby ${version}`);

    //  Only this line goes to stdout, so a script can pass it on:
    //  docker buildx build --platform "$(deno task -q docker-context)"
    console.log(ready.join(","));
}

//  Same as build.js: these are user errors, so print the message, not
//  a stack trace.
if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        Deno.exit(1);
    }
}
