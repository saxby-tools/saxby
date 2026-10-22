//  =====================================================================
//  Service adapters
//  =====================================================================
//  Mirrors the backend adapter registry: one static class per
//  supervisor, picked by platform. Every method takes the instance
//  name, so two instances never share a label or a unit.

import { LaunchdAdapter } from "./launchd.js";
import { SystemdAdapter } from "./systemd.js";

/**
 * @typedef {Object} ServiceAdapter
 * @property {string} id
 * @property {string} displayName
 * @property {() => boolean} isSupported - True on this adapter's OS.
 * @property {() => Promise<void>} preflight - Throws if unusable here.
 * @property {(instance: string | null) => string} name - Label or unit.
 * @property {(instance: string | null) => string} path - Service file.
 * @property {(instance: string | null) => string} logHint
 * @property {(spec: Object) => string} render - Service file text.
 * @property {(spec: Object) => Promise<void>} install
 * @property {(instance: string | null) => Promise<void>} uninstall
 * @property {(instance: string | null) => Promise<void>} restart
 * @property {(instance: string | null) => Promise<Object>} status
 */

/** @type {ServiceAdapter[]} */
export const SERVICE_ADAPTERS = [LaunchdAdapter, SystemdAdapter];

/**
 * The adapter for this platform, or null when none supports it.
 * @returns {ServiceAdapter | null}
 */
export function findServiceAdapter() {
    return SERVICE_ADAPTERS.find((adapter) => adapter.isSupported()) ??
        null;
}
