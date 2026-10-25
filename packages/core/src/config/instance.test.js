import {
    assertEquals,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import {
    instanceLabel,
    instancePhrase,
    resolveInstanceName,
    validateInstanceName,
} from "./instance.js";

Deno.test("validateInstanceName — accepts the narrow alphabet", () => {
    assertEquals(validateInstanceName("dev"), "dev");
    assertEquals(validateInstanceName("bge-m3"), "bge-m3");
    assertEquals(validateInstanceName("2"), "2");
});

Deno.test("validateInstanceName — rejects what breaks a label", () => {
    const bad = ["Dev", "dev.test", "dev_test", "-dev", "dev env", ""];

    for (const name of bad) {
        assertThrows(() => validateInstanceName(name));
    }
});

Deno.test("validateInstanceName — default is never a folder name", () => {
    assertThrows(() => validateInstanceName("default"), Error, "reserved");
});

Deno.test("resolveInstanceName — 'default' is the default instance", () => {
    const notes = [];
    const warn = console.warn;
    console.warn = (message) => notes.push(message);

    try {
        assertEquals(resolveInstanceName("default"), null);
    } finally {
        console.warn = warn;
    }

    assertEquals(notes.length, 1);
    assertStringIncludes(notes[0], "reserved for the default instance");
});

Deno.test("resolveInstanceName — a flag wins without reading env", () => {
    //  Runs without --allow-env, so reaching Deno.env would throw.
    assertEquals(resolveInstanceName("dev"), "dev");
});

Deno.test("instancePhrase — one wording for every instance", () => {
    assertEquals(instanceLabel(null), "default");
    assertEquals(instanceLabel("dev"), "dev");
    assertEquals(instancePhrase(null), "the default instance");
    assertEquals(instancePhrase("dev"), "the dev instance");
});
