import { assert, assertEquals } from "@std/assert";
import { parse as parseJsonc } from "@std/jsonc";
import { PROXY_KIND_TAILSCALE_SERVE, validateConfig } from "@saxby/core";
import {
    buildTrustedProxies,
    checkProxyHost,
    renderJsoncConfig,
} from "./generate.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  The smallest payload generate writes, with the prompts answered
//  the way pressing Enter answers them. Nothing here opens a
//  terminal: the prompts are not run, only what they produce.

const MODEL = "fixture-model";
const TAILNET_NAME = "my-mac.my-tailnet.ts.net";

const FRESH_PAYLOAD = {
    listen_port: 11435,
    upstream_url: "http://127.0.0.1:11434",
    global_default_model: MODEL,
    catalog: {
        [MODEL]: { name: MODEL, max_context: 8192, capabilities: [] },
    },
    personas: {},
    log_prompts: false,
    log_proxy_users: false,
    forward_user_headers: false,
    client_defaults: {},
    trusted_proxies: [],
};

//  What loadConfig does to the file, minus the file.
function loadRendered(payload) {
    return validateConfig(parseJsonc(renderJsoncConfig(payload)));
}

//  The comment lines directly above a top-level key, or [] when the
//  key has none.
function commentAbove(rendered, key) {
    const lines = rendered.split("\n");
    const at = lines.findIndex((line) => line.startsWith(`    "${key}":`));

    assert(at >= 0, `${key} is not in the rendered file`);

    const comments = [];

    for (let i = at - 1; i >= 0; i -= 1) {
        if (!lines[i].trim().startsWith("//")) {
            break;
        }

        comments.unshift(lines[i].trim());
    }

    return comments;
}

//  =====================================================================
//  A fresh config keeps both off
//  =====================================================================

Deno.test("fresh config — both keys are written off and it loads", () => {
    const config = loadRendered(FRESH_PAYLOAD);

    assertEquals(config.trusted_proxies, []);
    assertEquals(config.client_defaults, {});
});

Deno.test("fresh config — the file says both keys exist", () => {
    const rendered = renderJsoncConfig(FRESH_PAYLOAD);

    for (const key of ["trusted_proxies", "client_defaults"]) {
        const comments = commentAbove(rendered, key);

        assert(comments.length > 0, `${key} has no comment above it`);
        assert(
            comments.some((line) => line.includes("Empty")),
            `${key}'s comment does not say it is off`,
        );
    }
});

Deno.test("fresh config — proxied callers are written off, and why", () => {
    const config = loadRendered(FRESH_PAYLOAD);
    const comments = commentAbove(
        renderJsoncConfig(FRESH_PAYLOAD),
        "log_proxy_users",
    );

    assertEquals(config.log_proxy_users, false);
    assert(
        comments.some((line) => line.includes("False by default")),
        "log_proxy_users's comment does not say it is off",
    );
});

Deno.test("fresh config — user headers are written off, and why", () => {
    const config = loadRendered(FRESH_PAYLOAD);
    const comments = commentAbove(
        renderJsoncConfig(FRESH_PAYLOAD),
        "forward_user_headers",
    );

    assertEquals(config.forward_user_headers, false);
    assert(
        comments.some((line) => line.includes("False by default")),
        "forward_user_headers's comment does not say it is off",
    );
});

//  =====================================================================
//  Answering Yes writes one Tailscale Serve proxy
//  =====================================================================

Deno.test("tailnet name — one Serve entry is written and loads", () => {
    const config = loadRendered({
        ...FRESH_PAYLOAD,
        trusted_proxies: buildTrustedProxies(TAILNET_NAME),
    });

    assertEquals(config.trusted_proxies, [
        { kind: PROXY_KIND_TAILSCALE_SERVE, host: TAILNET_NAME },
    ]);
});

Deno.test("tailnet name — surrounding whitespace is dropped", () => {
    assertEquals(buildTrustedProxies(`  ${TAILNET_NAME}\n`), [
        { kind: PROXY_KIND_TAILSCALE_SERVE, host: TAILNET_NAME },
    ]);
});

//  =====================================================================
//  The prompt accepts only what the schema accepts
//  =====================================================================

Deno.test("prompt — a bare tailnet name passes", () => {
    assertEquals(checkProxyHost(TAILNET_NAME), true);
    assertEquals(checkProxyHost(`  ${TAILNET_NAME} `), true);
});

const REFUSED = [
    `https://${TAILNET_NAME}`,
    `${TAILNET_NAME}:11435`,
    `${TAILNET_NAME}/v1`,
    "",
];

for (const value of REFUSED) {
    Deno.test(`prompt — '${value}' is refused with a reason`, () => {
        const answer = checkProxyHost(value);

        assertEquals(typeof answer, "string");
        assert(answer.length > 0, "the reason is empty");
    });
}
