//  =====================================================================
//  macOS memory probe
//  =====================================================================
//  Apple Silicon shares one pool of memory between CPU and GPU. GPU
//  memory is wired: it cannot be paged out, and when wired pages ran
//  out on Oct. 27, 2026, the kernel panicked.
//
//  Ceiling: `iogpu.wired_limit_mb`, the most the GPU may wire. When
//  it is above 0 it is also Metal's recommendedMaxWorkingSetSize,
//  checked on an M5 Max: Metal reported 103,079,215,104 bytes with
//  the limit at 98,304 MiB, the same number. That matters because
//  PyTorch's memory cap is a ratio of Metal's value.
//
//  When the limit is 0, macOS uses its own default, and only Metal
//  reports it. Ollama logs it but has no API for it, and asking Metal
//  means compiling Swift, which takes seconds and opens an install
//  dialog on a Mac without the command-line tools. So the probe says
//  "unknown" and the config's memory.ceiling_gib fills the gap.
//
//  Usage: wired pages from `vm_stat`. Observed only, never budgeted:
//  wired also holds the kernel, and MLX wires lazily, so it can read
//  below what Ollama has committed. It is logged as evidence.
//
//  Absolute paths, matching saxbyd's --allow-run list exactly, so a
//  changed PATH cannot swap in another program.

import { BYTES_PER_MIB } from "../units.js";

const SYSCTL_PATH = "/usr/sbin/sysctl";
const VM_STAT_PATH = "/usr/bin/vm_stat";

const WIRED_LIMIT_KEY = "iogpu.wired_limit_mb";

const PAGE_SIZE_PATTERN = /page size of (\d+) bytes/;
const WIRED_PAGES_PATTERN = /^Pages wired down:\s+(\d+)\./m;
const WHOLE_NUMBER_PATTERN = /^\d+$/;

/**
 * Reads `sysctl -n iogpu.wired_limit_mb` output.
 * @param {string} text
 * @returns {number | null} MiB, or null when the text is not a number.
 */
export function parseWiredLimitMb(text) {
    const value = text.trim();

    if (!WHOLE_NUMBER_PATTERN.test(value)) {
        return null;
    }

    return Number(value);
}

/**
 * Reads wired memory from `vm_stat` output. The page size comes from
 * vm_stat's own header, never a constant: Apple Silicon uses 16 KiB
 * pages and Intel 4 KiB.
 * @param {string} text
 * @returns {number | null} Bytes, or null when either line is missing.
 */
export function parseVmStatWired(text) {
    const pageSize = text.match(PAGE_SIZE_PATTERN);
    const wiredPages = text.match(WIRED_PAGES_PATTERN);

    if (!pageSize) {
        return null;
    }

    if (!wiredPages) {
        return null;
    }

    return Number(wiredPages[1]) * Number(pageSize[1]);
}

/**
 * Runs a program and returns its exit code and output. A program that
 * cannot start, or is not on the permission list, reports code -1
 * instead of throwing, so one failed reading never stops a budget.
 * @param {string} path
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string }>}
 */
async function runProgram(path, args) {
    try {
        const output = await new Deno.Command(path, {
            args,
            stdout: "piped",
            stderr: "null",
        }).output();

        return {
            code: output.code,
            stdout: new TextDecoder().decode(output.stdout),
        };
    } catch {
        return { code: -1, stdout: "" };
    }
}

function readCeiling(result) {
    if (result.code !== 0) {
        return {
            ceilingBytes: null,
            ceilingSource: `${WIRED_LIMIT_KEY} could not be read ` +
                `(Apple Silicon only)`,
        };
    }

    const limitMb = parseWiredLimitMb(result.stdout);

    if (limitMb === null) {
        return {
            ceilingBytes: null,
            ceilingSource: `${WIRED_LIMIT_KEY} was not a number`,
        };
    }

    if (limitMb === 0) {
        return {
            ceilingBytes: null,
            ceilingSource: `${WIRED_LIMIT_KEY} is 0, the macOS default, ` +
                `which only Metal reports`,
        };
    }

    return {
        ceilingBytes: limitMb * BYTES_PER_MIB,
        ceilingSource: WIRED_LIMIT_KEY,
    };
}

function readUsage(result) {
    if (result.code !== 0) {
        return { usedBytes: null, usedSource: "vm_stat could not run" };
    }

    const wired = parseVmStatWired(result.stdout);

    if (wired === null) {
        return { usedBytes: null, usedSource: "vm_stat had no wired line" };
    }

    return { usedBytes: wired, usedSource: "vm_stat wired" };
}

export class DarwinMemoryProbe {
    static id = "darwin";
    static displayName = "macOS (Apple Silicon)";

    static isSupported() {
        return Deno.build.os === "darwin";
    }

    /**
     * @param {typeof runProgram} [run] - Injected by tests.
     * @returns {Promise<import("./index.js").MemoryReading>}
     */
    static async read(run = runProgram) {
        const [limit, vmStat] = await Promise.all([
            run(SYSCTL_PATH, ["-n", WIRED_LIMIT_KEY]),
            run(VM_STAT_PATH, []),
        ]);

        return {
            ...readCeiling(limit),
            ...readUsage(vmStat),
        };
    }
}
