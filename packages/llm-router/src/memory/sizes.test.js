import { assertEquals } from "@std/assert";
import { createSizeCache } from "./sizes.js";

const GIB = 2 ** 30;

Deno.test("sizes — a loaded model's size is remembered", () => {
    const cache = createSizeCache({ now: () => 0 });

    cache.record([{ name: "gemma4:31b-128k", bytes: 26 * GIB }]);

    assertEquals(cache.get("gemma4:31b-128k"), {
        bytes: 26 * GIB,
        measuredAt: new Date(0).toISOString(),
    });
});

Deno.test("sizes — saved rows survive a restart", () => {
    const cache = createSizeCache({
        rows: [{
            model: "granite4:micro-h",
            bytes: 4 * GIB,
            measuredAt: "2026-10-27T20:00:00.000Z",
        }],
    });

    assertEquals(cache.get("granite4:micro-h")?.bytes, 4 * GIB);
});

Deno.test("sizes — only a change is saved", () => {
    const saved = [];
    const cache = createSizeCache({
        save: (model, bytes) => saved.push([model, bytes]),
    });

    cache.record([{ name: "bge-m3:latest", bytes: GIB }]);
    cache.record([{ name: "bge-m3:latest", bytes: GIB }]);
    cache.record([{ name: "bge-m3:latest", bytes: 2 * GIB }]);

    assertEquals(saved, [
        ["bge-m3:latest", GIB],
        ["bge-m3:latest", 2 * GIB],
    ]);
});

Deno.test("sizes — a partial load is not a measurement", () => {
    const cache = createSizeCache({ now: () => 0 });

    cache.record([{ name: "gemma4:31b-128k", bytes: 26 * GIB }]);
    cache.record([{ name: "gemma4:31b-128k", bytes: 16 * GIB, partial: true }]);

    assertEquals(cache.get("gemma4:31b-128k")?.bytes, 26 * GIB);
});

Deno.test("sizes — a model wholly on the CPU is not measured", () => {
    const cache = createSizeCache();

    cache.record([{ name: "granite4:micro-h", bytes: 0 }]);

    assertEquals(cache.get("granite4:micro-h"), null);
});

Deno.test("sizes — a model never seen is null", () => {
    assertEquals(createSizeCache().get("ghost:latest"), null);
});
