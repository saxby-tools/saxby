import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { gibToBytes } from "@saxby/core";
import {
    computeBudget,
    decideLoad,
    decideReservation,
    describeBudget,
} from "./budget.js";

//  =====================================================================
//  Fixture
//  =====================================================================
//  Shaped like the M5 Max on 2026-10-27: a 96 GiB ceiling, three
//  pinned models, and Qwen loaded but not pinned. Round sizes keep the
//  arithmetic checkable by eye.

function terms(overrides = {}) {
    return {
        ceilingBytes: gibToBytes(96),
        ceilingSource: "iogpu.wired_limit_mb",
        marginBytes: gibToBytes(8),
        pinned: [
            {
                model: "gemma4:31b-128k",
                bytes: gibToBytes(26),
                source: "loaded",
            },
            {
                model: "granite4:micro-h",
                bytes: gibToBytes(4),
                source: "measured",
            },
            {
                model: "bge-m3:latest",
                bytes: gibToBytes(1),
                source: "size_gib",
            },
        ],
        loaded: [{ model: "qwen3.8:27b", bytes: gibToBytes(25) }],
        reservedBytes: 0,
        residencyError: null,
        usedBytes: null,
        usedSource: "vm_stat wired",
        ...overrides,
    };
}

//  96 - 8 - (26 + 4 + 1) - 25 - 0
const FREE_GIB = 32;

//  96 - 8 - 31: what waiting could ever free.
const ROOM_GIB = 57;

//  =====================================================================
//  computeBudget
//  =====================================================================

Deno.test("budget — free is the ceiling less every term", () => {
    const budget = computeBudget(terms());

    assertEquals(budget.freeBytes, gibToBytes(FREE_GIB));
    assertEquals(budget.pinnedBytes, gibToBytes(31));
    assertEquals(budget.loadedBytes, gibToBytes(25));
    assertEquals(budget.unknowns, []);
});

Deno.test("budget — reservations come out of free", () => {
    const budget = computeBudget(terms({ reservedBytes: gibToBytes(10) }));

    assertEquals(budget.freeBytes, gibToBytes(FREE_GIB - 10));
});

Deno.test("budget — an unknown ceiling makes free unknown", () => {
    const budget = computeBudget(terms({
        ceilingBytes: null,
        ceilingSource: "iogpu.wired_limit_mb is 0",
    }));

    assertEquals(budget.freeBytes, null);
    assertStringIncludes(budget.unknowns[0], "iogpu.wired_limit_mb is 0");
});

Deno.test("budget — a pinned model with no size makes free unknown", () => {
    const budget = computeBudget(terms({
        pinned: [{ model: "gemma4:31b-128k", bytes: null, source: "unknown" }],
    }));

    assertEquals(budget.freeBytes, null);
    assertStringIncludes(budget.unknowns[0], "gemma4:31b-128k");
});

Deno.test("budget — a backend that cannot answer makes free unknown", () => {
    const budget = computeBudget(terms({ residencyError: "timed out" }));

    assertEquals(budget.freeBytes, null);
    assertStringIncludes(budget.unknowns[0], "timed out");
});

Deno.test("budget — the description shows every term", () => {
    const text = describeBudget(computeBudget(terms()));

    assertEquals(
        text,
        "32.0 GiB free (ceiling 96.0 GiB - margin 8.0 GiB - pinned " +
            "31.0 GiB - loaded 25.0 GiB - reserved 0.0 GiB)",
    );
});

//  =====================================================================
//  decideReservation
//  =====================================================================

Deno.test("reserve — a job that fits is admitted", () => {
    const got = decideReservation(computeBudget(terms()), gibToBytes(30));

    assert(got.fits);
});

Deno.test("reserve — a job bigger than free waits", () => {
    const got = decideReservation(computeBudget(terms()), gibToBytes(40));

    assert(!got.fits);
    assert(!got.neverFits);
    assertStringIncludes(got.reason, "40.0 GiB wanted");
});

Deno.test("reserve — a job bigger than the room never fits", () => {
    const got = decideReservation(
        computeBudget(terms()),
        gibToBytes(ROOM_GIB + 1),
    );

    assert(!got.fits);
    assert(got.neverFits);
});

Deno.test("reserve — a pinned model's space is held while unloaded", () => {
    //  Nothing loaded at all: the pinned 31 GiB still counts.
    const budget = computeBudget(terms({ loaded: [] }));
    const got = decideReservation(budget, gibToBytes(ROOM_GIB + 1));

    assert(got.neverFits);
});

Deno.test("reserve — an unknown budget admits nothing", () => {
    const budget = computeBudget(terms({ ceilingBytes: null }));
    const got = decideReservation(budget, gibToBytes(1));

    assert(!got.fits);
    assert(!got.neverFits);
});

//  =====================================================================
//  decideLoad
//  =====================================================================

function target(overrides = {}) {
    return {
        model: "voxtral:32k",
        pinned: false,
        bytes: gibToBytes(10),
        source: "measured",
        ...overrides,
    };
}

Deno.test("load — a model that fits is admitted", () => {
    const got = decideLoad(computeBudget(terms()), target());

    assert(got.fits);
});

Deno.test("load — a model bigger than free waits", () => {
    const budget = computeBudget(terms({ reservedBytes: gibToBytes(30) }));
    const got = decideLoad(budget, target());

    assert(!got.fits);
    assert(!got.neverFits);
    assertStringIncludes(got.reason, "'voxtral:32k' needs 10.0 GiB");
});

Deno.test("load — a pinned model fits even with no budget", () => {
    const budget = computeBudget(terms({ ceilingBytes: null }));
    const got = decideLoad(budget, target({ pinned: true }));

    assert(got.fits);
});

Deno.test("load — a model of unknown size waits", () => {
    const got = decideLoad(
        computeBudget(terms()),
        target({ bytes: null, source: "unknown" }),
    );

    assert(!got.fits);
    assertStringIncludes(got.reason, "no known size");
});

Deno.test("load — a model bigger than the room never fits", () => {
    const got = decideLoad(
        computeBudget(terms()),
        target({ bytes: gibToBytes(ROOM_GIB + 1) }),
    );

    assert(got.neverFits);
});
