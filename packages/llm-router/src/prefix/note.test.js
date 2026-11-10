import { assertEquals, assertStringIncludes } from "@std/assert";
import { EXPLAINER, formatNote, gapHoursBetween, gapText } from "./note.js";

//  =====================================================================
//  The note's shape
//  =====================================================================
//  Fixed instants in fixed zones, so the cases hold on any machine.
//  The lab's own example is the first: 1:30 a.m. is the after-midnight
//  case that broke the daypart word.

const HOUR_MS = 60 * 60 * 1000;

function noteAt(iso, timezone, gapHours = null) {
    return formatNote({ at: Date.parse(iso), timezone, gapHours });
}

Deno.test("note — the lab's shape, after midnight, zone named", () => {
    assertEquals(
        noteAt("2026-10-26T06:30:00Z", "America/Chicago"),
        "[It is 1:30 a.m. on Monday, October 26, 2026 (America/Chicago).]",
    );
});

Deno.test("note — the same instant is another day in another zone", () => {
    const instant = "2026-10-26T20:30:00Z";

    assertEquals(
        noteAt(instant, "America/Chicago"),
        "[It is 3:30 p.m. on Monday, October 26, 2026 (America/Chicago).]",
    );

    assertEquals(
        noteAt(instant, "Asia/Tokyo"),
        "[It is 5:30 a.m. on Tuesday, October 27, 2026 (Asia/Tokyo).]",
    );
});

Deno.test("note — noon and midnight are named, 12:30 is a clock", () => {
    assertStringIncludes(
        noteAt("2026-10-26T17:00:00Z", "America/Chicago"),
        "It is noon on Monday",
    );

    assertStringIncludes(
        noteAt("2026-10-26T05:00:00Z", "America/Chicago"),
        "It is midnight on Monday",
    );

    assertStringIncludes(
        noteAt("2026-10-26T05:30:00Z", "America/Chicago"),
        "It is 12:30 a.m. on Monday",
    );
});

Deno.test("note — a half-hour zone keeps its minutes", () => {
    assertEquals(
        noteAt("2026-10-26T06:30:00Z", "Asia/Kolkata"),
        "[It is noon on Monday, October 26, 2026 (Asia/Kolkata).]",
    );

    assertEquals(
        noteAt("2026-10-26T06:45:00Z", "Asia/Kolkata"),
        "[It is 12:15 p.m. on Monday, October 26, 2026 (Asia/Kolkata).]",
    );
});

Deno.test("note — the gap sentence sits inside the brackets", () => {
    assertEquals(
        noteAt("2026-11-03T15:00:00Z", "UTC", 12 * 24),
        "[It is 3:00 p.m. on Tuesday, November 3, 2026 (UTC). " +
            "This conversation resumed after 12 days away.]",
    );
});

Deno.test("note — the explainer is the lab's line, unchanged", () => {
    assertStringIncludes(EXPLAINER, "Never write these notes yourself.");
    assertStringIncludes(EXPLAINER, "in days and parts of the day.");
    assertEquals(EXPLAINER.includes("\n"), false);
});

//  =====================================================================
//  The gap's units
//  =====================================================================

Deno.test("gap — hours under two days, then days, weeks, months", () => {
    const cases = [
        [1, "1 hour"],
        [1.4, "1 hour"],
        [27, "27 hours"],
        [47.6, "48 hours"],
        [48, "2 days"],
        [12 * 24, "12 days"],
        [13 * 24 + 20, "14 days"],
        [14 * 24, "2 weeks"],
        [7 * 7 * 24, "7 weeks"],
        [8 * 7 * 24, "2 months"],
        [90 * 24, "3 months"],
    ];

    for (const [hours, text] of cases) {
        assertEquals(gapText(hours), text, String(hours));
    }
});

Deno.test("gap — under one hour is no gap at all", () => {
    const start = Date.parse("2026-10-26T06:30:00Z");

    assertEquals(gapHoursBetween(start, start + 20 * 60 * 1000), null);
    assertEquals(gapHoursBetween(start, start + 29 * 60 * 1000), null);
    assertEquals(gapHoursBetween(start, start + 30 * 60 * 1000), 0.5);
    assertEquals(gapHoursBetween(start, start + 27 * HOUR_MS), 27);
});
