//  =====================================================================
//  deno task sign-macos
//  =====================================================================
//  Signs and notarizes the macOS binaries a build staged, then packs
//  them again, so the tarballs a release carries hold signed bytes.
//  Runs after `deno task build all`, on a Mac, from the release
//  workflow only: a tarball downloaded through a browser gets the
//  quarantine flag, and Gatekeeper blocks an unsigned binary inside
//  (issue #7). Homebrew installs were never affected.
//
//  Per darwin stage directory under dist/:
//
//    1. codesign both binaries with the Developer ID identity, the
//       hardened runtime, the JIT entitlements V8 needs and a
//       timestamp, then verify strictly.
//    2. Zip them and submit the zip to Apple's notary service, waiting
//       for the verdict. A bare executable cannot be stapled, so the
//       ticket stays with Apple and Gatekeeper checks it online, which
//       is fine for a download.
//    3. Pack the tarball and its checksum again (scripts/build.js).
//
//  Everything comes from the environment, set by the workflow from
//  the repository secrets; nothing is read from a file in the repo:
//
//    SAXBY_SIGN_IDENTITY   the identity name, as `security
//                          find-identity` prints it
//    SAXBY_NOTARY_KEY      path to the App Store Connect API key (.p8)
//    SAXBY_NOTARY_KEY_ID   its key id
//    SAXBY_NOTARY_ISSUER   its issuer id
//    SAXBY_NOTARIZE=skip   sign only; for a local check with the
//                          ad-hoc identity "-", never for a release
//
//  Fails closed: with the identity set and the notary key missing,
//  nothing is packed, so a release cannot ship half done.

import { basename, join } from "@std/path";
import { DIST_DIR, pack } from "./build.js";

const BINARIES = ["saxbyd", "saxby"];

//  V8 compiles JavaScript at run time, which the hardened runtime
//  forbids unless the binary is entitled to it (the plist says why).
const ENTITLEMENTS = "scripts/macos-entitlements.plist";

const STAGE_PATTERN = /^saxby-.+-darwin-(arm64|x64)$/;

const IDENTITY_VAR = "SAXBY_SIGN_IDENTITY";
const NOTARY_KEY_VAR = "SAXBY_NOTARY_KEY";
const NOTARY_KEY_ID_VAR = "SAXBY_NOTARY_KEY_ID";
const NOTARY_ISSUER_VAR = "SAXBY_NOTARY_ISSUER";
const NOTARIZE_VAR = "SAXBY_NOTARIZE";
const NOTARIZE_SKIP = "skip";

const NOTARY_ACCEPTED = "Accepted";

function readSettings() {
    const identity = Deno.env.get(IDENTITY_VAR);

    if (!identity) {
        throw new Error(`${IDENTITY_VAR} is not set; nothing to sign with.`);
    }

    const skip = Deno.env.get(NOTARIZE_VAR) === NOTARIZE_SKIP;

    if (skip) {
        return { identity, notary: null };
    }

    const notary = {
        key: Deno.env.get(NOTARY_KEY_VAR),
        keyId: Deno.env.get(NOTARY_KEY_ID_VAR),
        issuer: Deno.env.get(NOTARY_ISSUER_VAR),
    };

    for (const [name, value] of Object.entries(notary)) {
        if (!value) {
            throw new Error(
                `${name} for notarization is not set; set it, or ` +
                    `${NOTARIZE_VAR}=${NOTARIZE_SKIP} for a signed-only ` +
                    `local check.`,
            );
        }
    }

    return { identity, notary };
}

async function run(command, args) {
    const child = new Deno.Command(command, {
        args,
        stdout: "piped",
        stderr: "piped",
    });

    const { code, stdout, stderr } = await child.output();
    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);

    if (code !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} exited ${code}\n${err}${out}`,
        );
    }

    return out;
}

async function findStages() {
    const stages = [];

    for await (const entry of Deno.readDir(DIST_DIR)) {
        if (!entry.isDirectory) {
            continue;
        }

        if (!STAGE_PATTERN.test(entry.name)) {
            continue;
        }

        stages.push(entry.name);
    }

    if (stages.length === 0) {
        throw new Error(
            `No darwin stage directory under ${DIST_DIR}/; run ` +
                `\`deno task build all\` first.`,
        );
    }

    return stages.sort();
}

async function sign(binaryPath, identity) {
    await run("codesign", [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--entitlements",
        ENTITLEMENTS,
        "--sign",
        identity,
        binaryPath,
    ]);

    await run("codesign", ["--verify", "--strict", "--verbose=2", binaryPath]);
}

//  ditto writes the zip Apple's notary service expects; -c -k are
//  "create" and "PKZip", --keepParent keeps the folder name inside.
async function zipStage(stageDir) {
    const zipPath = `${stageDir}.zip`;

    await Deno.remove(zipPath).catch(() => {});
    await run("ditto", ["-c", "-k", "--keepParent", stageDir, zipPath]);

    return zipPath;
}

async function notarize(zipPath, notary) {
    const out = await run("xcrun", [
        "notarytool",
        "submit",
        zipPath,
        "--key",
        notary.key,
        "--key-id",
        notary.keyId,
        "--issuer",
        notary.issuer,
        "--wait",
        "--output-format",
        "json",
    ]);

    const verdict = JSON.parse(out);

    if (verdict.status !== NOTARY_ACCEPTED) {
        throw new Error(
            `Notarization of ${basename(zipPath)} ended ` +
                `${verdict.status} (submission ${verdict.id}); ` +
                `\`xcrun notarytool log ${verdict.id}\` says why.`,
        );
    }

    return verdict.id;
}

async function signStage(stageName, settings) {
    const stageDir = join(DIST_DIR, stageName);

    for (const binary of BINARIES) {
        await sign(join(stageDir, binary), settings.identity);
        console.log(`🔏 ${stageName}: ${binary} signed`);
    }

    if (settings.notary === null) {
        console.log(`⏭️  ${stageName}: notarization skipped`);
    }

    if (settings.notary !== null) {
        const zipPath = await zipStage(stageDir);
        const id = await notarize(zipPath, settings.notary);

        await Deno.remove(zipPath);
        console.log(`📜 ${stageName}: notarized (${id})`);
    }

    const archivePath = await pack(stageName);

    console.log(`📦 ${archivePath} repacked\n`);
}

async function main() {
    const settings = readSettings();
    const stages = await findStages();

    for (const stageName of stages) {
        await signStage(stageName, settings);
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (err) {
        console.error(`❌ ${err.message}`);
        Deno.exit(1);
    }
}
