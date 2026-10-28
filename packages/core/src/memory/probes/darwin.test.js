import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    DarwinMemoryProbe,
    parseVmStatWired,
    parseWiredLimitMb,
} from "./darwin.js";

//  =====================================================================
//  Fixtures
//  =====================================================================
//  Real output from an M5 Max, 128 GiB, macOS 26, on 2026-10-27.

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  4668721.
Pages active:                                1028027.
Pages inactive:                              1021315.
Pages speculative:                              5377.
Pages throttled:                                   0.
Pages wired down:                            1561167.
Pages purgeable:                               14486.
"Translation faults":                       37916371.
`;

const WIRED_BYTES = 1561167 * 16384;

//  98,304 MiB, the limit vram-guard-mac's override sets. Metal's
//  recommendedMaxWorkingSetSize read the same on that machine.
const LIMIT_BYTES = 103079215104;

function fakeRun(outputs) {
    return (path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);

        return Promise.resolve(outputs[name]);
    };
}

//  =====================================================================
//  Parsers
//  =====================================================================

Deno.test("the wired limit reads as MiB", () => {
    assertEquals(parseWiredLimitMb("98304\n"), 98304);
});

Deno.test("a wired limit that is not a number reads as null", () => {
    assertEquals(parseWiredLimitMb("unknown oid\n"), null);
});

Deno.test("wired memory uses vm_stat's own page size", () => {
    assertEquals(parseVmStatWired(VM_STAT), WIRED_BYTES);
});

Deno.test("Intel's 4 KiB pages are read from the header too", () => {
    const text = VM_STAT.replace("16384", "4096");

    assertEquals(parseVmStatWired(text), 1561167 * 4096);
});

Deno.test("vm_stat without a wired line reads as null", () => {
    const text = VM_STAT.replace(/^Pages wired down.*$/m, "");

    assertEquals(parseVmStatWired(text), null);
});

//  =====================================================================
//  read()
//  =====================================================================

Deno.test("a set wired limit is the ceiling", async () => {
    const reading = await DarwinMemoryProbe.read(fakeRun({
        sysctl: { code: 0, stdout: "98304\n" },
        vm_stat: { code: 0, stdout: VM_STAT },
    }));

    assertEquals(reading, {
        ceilingBytes: LIMIT_BYTES,
        ceilingSource: "iogpu.wired_limit_mb",
        usedBytes: WIRED_BYTES,
        usedSource: "vm_stat wired",
    });
});

Deno.test("a limit of 0 leaves the ceiling unknown and says why", async () => {
    const reading = await DarwinMemoryProbe.read(fakeRun({
        sysctl: { code: 0, stdout: "0\n" },
        vm_stat: { code: 0, stdout: VM_STAT },
    }));

    assertEquals(reading.ceilingBytes, null);
    assertStringIncludes(reading.ceilingSource, "macOS default");
});

Deno.test("a sysctl that fails leaves the ceiling unknown", async () => {
    const reading = await DarwinMemoryProbe.read(fakeRun({
        sysctl: { code: 1, stdout: "" },
        vm_stat: { code: 0, stdout: VM_STAT },
    }));

    assertEquals(reading.ceilingBytes, null);
    assertStringIncludes(reading.ceilingSource, "Apple Silicon only");
});

Deno.test("a vm_stat that fails costs usage, not the ceiling", async () => {
    const reading = await DarwinMemoryProbe.read(fakeRun({
        sysctl: { code: 0, stdout: "98304\n" },
        vm_stat: { code: -1, stdout: "" },
    }));

    assertEquals(reading.ceilingBytes, LIMIT_BYTES);
    assertEquals(reading.usedBytes, null);
});
