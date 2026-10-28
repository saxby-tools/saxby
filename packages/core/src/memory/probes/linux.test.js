import { assertEquals } from "@std/assert";
import { LinuxMemoryProbe, parseMeminfo } from "./linux.js";

//  The usual first lines of /proc/meminfo on a 64 GiB machine.
const MEMINFO = `MemTotal:       65536000 kB
MemFree:        20000000 kB
MemAvailable:   40000000 kB
Buffers:          500000 kB
HugePages_Total:       0
`;

Deno.test("meminfo kB fields read as bytes", () => {
    const fields = parseMeminfo(MEMINFO);

    assertEquals(fields.MemTotal, 65536000 * 1024);
    assertEquals(fields.MemAvailable, 40000000 * 1024);
});

Deno.test("meminfo lines without a kB unit are skipped", () => {
    assertEquals(parseMeminfo(MEMINFO).HugePages_Total, undefined);
});

Deno.test("Linux reports usage but never a ceiling", async () => {
    const reading = await LinuxMemoryProbe.read(() => Promise.resolve(MEMINFO));

    assertEquals(reading, {
        ceilingBytes: null,
        ceilingSource: "no Linux GPU probe yet",
        usedBytes: (65536000 - 40000000) * 1024,
        usedSource: "meminfo MemTotal - MemAvailable",
    });
});

Deno.test("an unreadable meminfo costs usage only", async () => {
    const reading = await LinuxMemoryProbe.read(() =>
        Promise.reject(new Error("denied"))
    );

    assertEquals(reading.ceilingBytes, null);
    assertEquals(reading.usedBytes, null);
});
