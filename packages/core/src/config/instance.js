//  =====================================================================
//  Instances
//  =====================================================================
//  An instance is a folder holding its own config, decision log and
//  exemplar vectors. Isolation is total because the decision log is
//  the point: dev traffic beside production rows would corrupt the
//  data that threshold calibration depends on.
//
//  No name resolves to the config root itself, so installs from
//  before instances existed need no migration. A name resolves to
//  instances/<name>/ under it.
//
//  One name becomes a folder, a launchd label suffix and a systemd
//  unit suffix, hence the narrow alphabet: a dot would make the label
//  ambiguous, and a leading hyphen reads as a flag.

import { join } from "@std/path";
import { getConfigDir } from "../utils/env.js";

const SHUNTD_DIR_NAME = "shuntd";
const INSTANCES_DIR_NAME = "instances";
const INSTANCE_ENV = "SHUNTD_INSTANCE";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

//  `default` would resolve to instances/default/, a second "default"
//  that is not the real one at the config root.
const RESERVED_NAMES = new Set(["default"]);

/**
 * Throws unless the name is safe as a folder, label and unit suffix.
 * @param {string} name
 * @returns {string} The same name, for chaining.
 */
export function validateInstanceName(name) {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid instance name '${name}': use lowercase letters, ` +
                `digits and hyphens, starting with a letter or digit.`,
        );
    }

    if (RESERVED_NAMES.has(name)) {
        throw new Error(
            `Instance name '${name}' is reserved. Omit the name to use ` +
                `the default instance.`,
        );
    }

    return name;
}

/**
 * Resolves the instance name: the flag wins, then SHUNTD_INSTANCE,
 * then none. The ONLY place the environment variable is read.
 * @param {string | undefined} flag - Value of --instance, if given.
 * @returns {string | null} A validated name, or null for the default.
 */
export function resolveInstanceName(flag) {
    if (flag) {
        return validateInstanceName(flag);
    }

    const fromEnv = Deno.env.get(INSTANCE_ENV);

    if (fromEnv) {
        return validateInstanceName(fromEnv);
    }

    return null;
}

/**
 * The directory holding an instance's config, log and vectors.
 * @param {string | null} name - A name from resolveInstanceName.
 * @returns {string}
 */
export function getInstanceDir(name = null) {
    const root = join(getConfigDir(), SHUNTD_DIR_NAME);

    if (!name) {
        return root;
    }

    return join(root, INSTANCES_DIR_NAME, validateInstanceName(name));
}

function isValidInstanceName(name) {
    if (!NAME_PATTERN.test(name)) {
        return false;
    }

    if (RESERVED_NAMES.has(name)) {
        return false;
    }

    return true;
}

/**
 * Every instance: the default (null) first, then named instances that
 * have a directory, sorted. Folders with invalid names are skipped,
 * since shunt could not have created them.
 * @returns {Promise<(string | null)[]>}
 */
export async function listInstances() {
    const instancesDir = join(getInstanceDir(null), INSTANCES_DIR_NAME);
    const named = [];

    let entries = [];

    try {
        entries = await Array.fromAsync(Deno.readDir(instancesDir));
    } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
            throw err;
        }
    }

    for (const entry of entries) {
        if (!entry.isDirectory) {
            continue;
        }

        if (!isValidInstanceName(entry.name)) {
            continue;
        }

        named.push(entry.name);
    }

    return [null, ...named.sort()];
}
