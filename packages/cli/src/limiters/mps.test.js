import { assertEquals, assertStringIncludes } from "@std/assert";
import { WIRED_LIMIT_KEY } from "@saxby/core";
import { MpsWatermarkLimiter } from "./mps.js";

const GIB = 2 ** 30;

//  98,304 MiB: the M5 Max's ceiling and Metal's working-set size.
const CEILING = 96 * GIB;

function environment(
    reservedBytes,
    ceilingBytes = CEILING,
    ceilingSource = WIRED_LIMIT_KEY,
) {
    return MpsWatermarkLimiter.environment({
        reservedBytes,
        ceilingBytes,
        ceilingSource,
    });
}

Deno.test("mps — the cap is the reservation's share of the ceiling", () => {
    const got = environment(40 * GIB);

    assertEquals(got.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO, "0.416666");
});

Deno.test("mps — the low watermark is set below the high one", () => {
    const got = environment(40 * GIB);
    const high = Number(got.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO);
    const low = Number(got.env.PYTORCH_MPS_LOW_WATERMARK_RATIO);

    //  PyTorch fails at startup if LOW > HIGH, and LOW defaults to 1.4.
    assertEquals(low <= high, true);
    assertEquals(got.env.PYTORCH_MPS_LOW_WATERMARK_RATIO, "0.343136");
});

Deno.test("mps — ratios round down, never above the reservation", () => {
    const got = environment(GIB);
    const high = Number(got.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO);

    assertEquals(high * CEILING <= GIB, true);
});

Deno.test("mps — a ratio that would round to 0 is refused", () => {
    //  0.0 turns PyTorch's cap OFF. Never send it.
    const got = environment(1024);

    assertStringIncludes(got.problem, "ratio of 0");
});

Deno.test("mps — no ceiling, no cap", () => {
    const got = environment(GIB, null);

    assertStringIncludes(got.problem, "unknown");
});

Deno.test("mps — a ceiling from the config is not Metal's, no cap", () => {
    //  memory.ceiling_gib may be anything; a ratio of it misses.
    const got = environment(
        12 * GIB,
        80 * GIB,
        "memory.ceiling_gib, because iogpu.wired_limit_mb is 0",
    );

    assertStringIncludes(got.problem, "memory.ceiling_gib");
    assertStringIncludes(got.problem, "vram-guard-mac");
});

Deno.test("mps — a ratio above PyTorch's bound is refused", () => {
    const got = environment(3 * CEILING);

    assertStringIncludes(got.problem, "PyTorch refuses");
});
