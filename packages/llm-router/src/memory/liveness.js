//  =====================================================================
//  Process liveness
//  =====================================================================
//  A reservation lives as long as the processes behind it. This asks
//  `kill -0 <pid>`: no signal is sent, but the kernel answers whether
//  the process exists AND belongs to this user. Another user's
//  process (EPERM) counts as not alive, so a reservation can't be
//  pinned to a system process such as pid 1 that never exits.
//
//  Why a program and not Deno.kill(pid, 0): Deno only allows that with
//  unrestricted --allow-run (checked on Deno 2.9.8), which would let
//  saxbyd start anything. Running /bin/kill by its absolute path needs
//  only that one entry on saxbyd's run list (scripts/build.js).
//
//  Linux's path is the util-linux one, which is also where merged-/usr
//  distributions put procps' kill. It has not been run on Linux yet.

const KILL_PATHS = {
    darwin: "/bin/kill",
    linux: "/usr/bin/kill",
};

/**
 * True for a positive whole number small enough to be a pid. Checked
 * before anything is passed to `kill`, so no other argument can reach
 * it.
 * @param {unknown} pid
 * @returns {boolean}
 */
export function isPid(pid) {
    if (!Number.isSafeInteger(pid)) {
        return false;
    }

    return pid > 0;
}

/**
 * Whether a process exists and is this user's.
 * @param {number} pid
 * @returns {Promise<boolean | null>} null when the answer is unknown:
 *     no `kill` for this platform, or it could not run. The broker
 *     keeps a reservation it cannot check, since dropping one whose
 *     job still holds memory is the unsafe direction.
 */
export async function isProcessAlive(pid) {
    if (!isPid(pid)) {
        return false;
    }

    const killPath = KILL_PATHS[Deno.build.os];

    if (!killPath) {
        return null;
    }

    try {
        const output = await new Deno.Command(killPath, {
            args: ["-0", String(pid)],
            stdout: "null",
            stderr: "null",
        }).output();

        return output.code === 0;
    } catch {
        return null;
    }
}
