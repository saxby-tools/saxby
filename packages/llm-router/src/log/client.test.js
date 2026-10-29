import { assertEquals } from "@std/assert";
import { createPromptHasher, identifyClient } from "./client.js";

function identify(headers, config = {}) {
    const lower = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );

    return identifyClient((name) => lower[name.toLowerCase()], config);
}

const AIOHTTP = "Python/3.11 aiohttp/3.13.5";

Deno.test("client — Open WebUI's user headers name the app", () => {
    const found = identify({
        "User-Agent": AIOHTTP,
        "X-OpenWebUI-User-Id": "u1",
    });

    assertEquals(found.id, "open-webui");
    assertEquals(found.source, "app_header");
});

Deno.test("client — Open WebUI's JWT mode names the app too", () => {
    const found = identify({
        "User-Agent": AIOHTTP,
        "X-OpenWebUI-User-Jwt": "a.b.c",
    });

    assertEquals(found.id, "open-webui");
});

Deno.test("client — without app headers, the User-Agent decides", () => {
    const found = identify({ "User-Agent": "OpenAI/JS 7.20.0" });

    assertEquals(found.id, "openai");
    assertEquals(found.source, "user_agent");
});

Deno.test("client — client_names renames a signature", () => {
    const found = identify(
        { "User-Agent": "OpenAI/JS 7.20.0" },
        { client_names: { openai: "openclaw" } },
    );

    assertEquals(found.id, "openclaw");
    assertEquals(found.signature, "openai");
});

//  RFC 4231, test case 2: HMAC-SHA-256 with a short key.
Deno.test("hash — matches the published HMAC-SHA-256 vector", async () => {
    const hash = await createPromptHasher(new TextEncoder().encode("Jefe"));

    assertEquals(
        await hash("what do ya want for nothing?"),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
});

Deno.test("hash — an empty or missing prompt still hashes", async () => {
    const hash = await createPromptHasher(new Uint8Array(32));

    assertEquals(await hash(""), await hash(null));
});
