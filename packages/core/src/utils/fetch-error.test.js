import { assertEquals } from "@std/assert";
import { describeFetchError } from "./fetch-error.js";

//  The cause text is what Deno 2.9.8 gives for a closed local port.
const CAUSE = "error sending request for url (http://127.0.0.1:11436/x): " +
    "client error (Connect): tcp connect error: Connection refused " +
    "(os error 61)";

Deno.test("fetch error — the last link of the cause is kept", () => {
    const err = new TypeError("fetch failed", { cause: new Error(CAUSE) });

    assertEquals(
        describeFetchError(err),
        "Connection refused (os error 61)",
    );
});

Deno.test("fetch error — no cause falls back to the message", () => {
    assertEquals(describeFetchError(new Error("timed out")), "timed out");
});

Deno.test("fetch error — a cause with no chain is kept whole", () => {
    const err = new TypeError("fetch failed", {
        cause: new Error("dns error"),
    });

    assertEquals(describeFetchError(err), "dns error");
});
