//  =====================================================================
//  The release version
//  =====================================================================
//  Packages are versioned in lockstep. Reading the version refuses to
//  answer if they disagree, so neither a build nor a release can ship
//  mixed versions.
//
//  Run directly to check a tag against the packages in CI:
//
//    deno run --allow-read scripts/version.js --expect 1.0.0

const PACKAGE_MANIFESTS = [
    "packages/cli/deno.json",
    "packages/core/deno.json",
    "packages/llm-router/deno.json",
    "packages/vram-guard-mac/deno.json",
];

export async function readLockstepVersion() {
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

async function main() {
    const version = await readLockstepVersion();
    const flag = Deno.args.indexOf("--expect");

    if (flag === -1) {
        console.log(version);
        return;
    }

    const expected = Deno.args[flag + 1];

    if (expected !== version) {
        console.error(
            `❌ Tag says ${expected}, packages say ${version}. ` +
                `Bump all four deno.json files before tagging.`,
        );
        Deno.exit(1);
    }

    console.log(`✅ ${version}`);
}

if (import.meta.main) {
    await main();
}
