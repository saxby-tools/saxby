import { assertEquals, assertThrows } from "@std/assert";
import { resolveInstanceName, validateInstanceName } from "./instance.js";

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

Deno.test("validateInstanceName — rejects the reserved default", () => {
    assertThrows(() => validateInstanceName("default"), Error, "reserved");
});

Deno.test("resolveInstanceName — a flag wins without reading env", () => {
    //  Runs without --allow-env, so reaching Deno.env would throw.
    assertEquals(resolveInstanceName("dev"), "dev");
});
