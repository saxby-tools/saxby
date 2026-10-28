//  =====================================================================
//  Linux memory probe (minimal)
//  =====================================================================
//  Proves the probe's shape on Linux, nothing more. It reads
//  /proc/meminfo, a file read, so saxbyd starts no program for it.
//
//  It reports usage (MemTotal minus MemAvailable) but never a
//  ceiling, because nothing in /proc/meminfo is one:
//
//    a GPU card      its memory is separate and fixed. A future
//                    NVIDIA probe would read nvidia-smi; an AMD one,
//                    the amdgpu sysfs files.
//    Strix Halo      the GPU's share is set at boot with kernel
//                    parameters (AGENTS.md). A future probe would read
//                    the GTT size the kernel reports.
//
//  Calling MemTotal the ceiling would budget the whole machine as GPU
//  memory. So the ceiling is unknown, and memory.ceiling_gib in the
//  config supplies it; without that, the broker refuses every job.

const MEMINFO_PATH = "/proc/meminfo";

//  /proc/meminfo says "kB" but means KiB.
const BYTES_PER_MEMINFO_KB = 1024;

const MEMINFO_LINE_PATTERN = /^(\w+):\s+(\d+) kB$/;

/**
 * Reads the kB fields of /proc/meminfo.
 * @param {string} text
 * @returns {Record<string, number>} Field name to bytes.
 */
export function parseMeminfo(text) {
    const fields = {};

    for (const line of text.split("\n")) {
        const match = line.trim().match(MEMINFO_LINE_PATTERN);

        if (!match) {
            continue;
        }

        fields[match[1]] = Number(match[2]) * BYTES_PER_MEMINFO_KB;
    }

    return fields;
}

function readUsage(fields) {
    if (fields.MemTotal === undefined) {
        return { usedBytes: null, usedSource: "no MemTotal in meminfo" };
    }

    if (fields.MemAvailable === undefined) {
        return { usedBytes: null, usedSource: "no MemAvailable in meminfo" };
    }

    return {
        usedBytes: fields.MemTotal - fields.MemAvailable,
        usedSource: "meminfo MemTotal - MemAvailable",
    };
}

export class LinuxMemoryProbe {
    static id = "linux";
    static displayName = "Linux (minimal)";

    static isSupported() {
        return Deno.build.os === "linux";
    }

    /**
     * @param {(path: string) => Promise<string>} [readText] - Injected
     *     by tests.
     * @returns {Promise<import("./index.js").MemoryReading>}
     */
    static async read(readText = Deno.readTextFile) {
        const ceiling = {
            ceilingBytes: null,
            ceilingSource: "no Linux GPU probe yet",
        };

        let text;

        try {
            text = await readText(MEMINFO_PATH);
        } catch {
            return {
                ...ceiling,
                usedBytes: null,
                usedSource: `${MEMINFO_PATH} could not be read`,
            };
        }

        return { ...ceiling, ...readUsage(parseMeminfo(text)) };
    }
}
