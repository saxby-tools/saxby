import { assertEquals } from "@std/assert";
import {
    TOKEN_INVALID,
    TOKEN_MISSING,
    TOKEN_UNAVAILABLE,
    TOKEN_VALID,
} from "./guard.js";
import { tokenStateFor } from "./token.js";

const TOKEN = "a".repeat(64);

Deno.test("token state — the right bearer token is valid", () => {
    const headers = [
        `Bearer ${TOKEN}`,
        `bearer ${TOKEN}`,
        `BEARER   ${TOKEN}`,
        `Bearer ${TOKEN} `,
    ];

    for (const header of headers) {
        assertEquals(tokenStateFor(header, TOKEN), TOKEN_VALID, header);
    }
});

Deno.test("token state — a wrong token is invalid", () => {
    const headers = [
        "Bearer saxby",
        `Bearer ${TOKEN}x`,
        `Bearer ${TOKEN.slice(1)}`,
        "Bearer placeholder",
    ];

    for (const header of headers) {
        assertEquals(tokenStateFor(header, TOKEN), TOKEN_INVALID, header);
    }
});

Deno.test("token state — no bearer token is missing", () => {
    const headers = [
        undefined,
        null,
        "",
        "Bearer",
        "Bearer ",
        TOKEN,
        `Basic ${TOKEN}`,
        `Bearer ${TOKEN} extra`,
    ];

    for (const header of headers) {
        assertEquals(
            tokenStateFor(header, TOKEN),
            TOKEN_MISSING,
            String(header),
        );
    }
});

Deno.test("token state — with no token file, nothing can be valid", () => {
    assertEquals(tokenStateFor(`Bearer ${TOKEN}`, null), TOKEN_UNAVAILABLE);
    assertEquals(tokenStateFor(undefined, null), TOKEN_UNAVAILABLE);
});

Deno.test("token state — a short token of the operator's own works", () => {
    assertEquals(tokenStateFor("Bearer saxby", "saxby"), TOKEN_VALID);
    assertEquals(tokenStateFor("Bearer saxbY", "saxby"), TOKEN_INVALID);
});
