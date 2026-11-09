import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
    createReloader,
    listChangedFields,
    RELOAD_APPLIED,
    RELOAD_DECLINED,
    RELOAD_UNCHANGED,
} from "./reload.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  The file, the embedder, the clock and the console are faked. `file`
//  is what the next load returns; an Error is thrown instead, as the
//  real loader does for a file that will not parse.

const BOOT_MS = Date.UTC(2026, 10, 9, 12, 0, 0);

function testConfig(overrides = {}) {
    return {
        listen_port: 11435,
        listen_host: "127.0.0.1",
        upstream_url: "http://ollama.test",
        global_default_model: "model-a",
        personas: {
            coder: { exemplars: ["refactor this"], default_model: "model-a" },
        },
        catalog: {
            "model-a": { name: "model-a", max_context: 8000 },
        },
        log_prompts: false,
        memory: { margin_gib: 8 },
        log_path: "/tmp/decision-log.db",
        ...overrides,
    };
}

const SEMANTIC_BLOCK = {
    active: "bge",
    profiles: { bge: { model: "bge-m3", dim: 3, threshold: 0.5 } },
};

function harness(options = {}) {
    let ms = BOOT_MS;
    let file = options.config ?? testConfig();
    let warmFailure = null;

    const said = [];
    const warned = [];
    const warmed = [];
    const applied = [];

    const reloader = createReloader({
        config: options.config ?? testConfig(),
        semantic: options.semantic ?? null,
        load: () => {
            if (file instanceof Error) {
                return Promise.reject(file);
            }

            return Promise.resolve(structuredClone(file));
        },
        warm: (config) => {
            warmed.push(config);

            if (warmFailure !== null) {
                return Promise.reject(warmFailure);
            }

            if (!config.semantic) {
                return Promise.resolve(null);
            }

            return Promise.resolve({ builtFor: config });
        },
        onApply: options.onApply ?? ((state, changed) => {
            applied.push({ state, changed });
        }),
        now: () => ms,
        say: (line) => said.push(line),
        warn: (line) => warned.push(line),
    });

    return {
        reloader,
        said,
        warned,
        warmed,
        applied,
        save: (next) => {
            file = next;
        },
        failWarm: (error) => {
            warmFailure = error;
        },
        advance: (by) => {
            ms += by;
        },
    };
}

//  =====================================================================
//  Applying
//  =====================================================================

Deno.test("reload — a changed file replaces the running config", async () => {
    const h = harness();
    const before = h.reloader.current();

    h.advance(60_000);
    h.save(testConfig({ global_default_model: "model-b", log_prompts: true }));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_APPLIED);
    assertEquals(got.changed, ["global_default_model", "log_prompts"]);

    const after = h.reloader.current();

    assertEquals(after.config.global_default_model, "model-b");
    assertEquals(h.reloader.status(), {
        loaded_at: "2026-11-09T12:01:00.000Z",
        declined: null,
    });

    //  Replaced, not edited: what a request in flight holds is whole.
    assert(after !== before);
    assertEquals(before.config.global_default_model, "model-a");

    assertEquals(h.applied.length, 1);
    assert(h.applied[0].state === after);
    assertEquals(h.said, [
        "🔄 Config reloaded: global_default_model, log_prompts changed.",
    ]);
});

Deno.test("reload — a save that changes nothing does nothing", async () => {
    const h = harness();
    const before = h.reloader.current();

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_UNCHANGED);
    assert(h.reloader.current() === before);
    assertEquals(h.applied, []);
    assertEquals(h.said, []);
    assertEquals(h.warned, []);
});

Deno.test("reload — a reordered catalog counts as a change", async () => {
    const two = {
        "model-a": { name: "model-a", max_context: 8000 },
        "model-b": { name: "model-b", max_context: 8000 },
    };

    const flipped = { "model-b": two["model-b"], "model-a": two["model-a"] };

    const h = harness({ config: testConfig({ catalog: two }) });

    h.save(testConfig({ catalog: flipped }));

    const got = await h.reloader.reload();

    assertEquals(got.changed, ["catalog"]);
});

//  =====================================================================
//  Declining
//  =====================================================================

Deno.test("reload — a bad file keeps the old config", async () => {
    const h = harness();
    const before = h.reloader.current();

    h.advance(5000);
    h.save(new Error("❌ Invalid config in config.jsonc:\n- oops"));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_DECLINED);
    assert(h.reloader.current() === before);
    assertEquals(h.applied, []);

    assertEquals(h.reloader.status(), {
        loaded_at: "2026-11-09T12:00:00.000Z",
        declined: {
            at: "2026-11-09T12:00:05.000Z",
            reason: "❌ Invalid config in config.jsonc:\n- oops",
        },
    });

    assertEquals(h.warned.length, 1);
    assertStringIncludes(h.warned[0], "NOT applied");
    assertStringIncludes(h.warned[0], "- oops");
});

Deno.test("reload — fixing the file clears the declined state", async () => {
    const h = harness();

    h.save(new Error("bad"));
    await h.reloader.reload();

    h.save(testConfig({ log_prompts: true }));
    await h.reloader.reload();

    assertEquals(h.reloader.status().declined, null);
    assertEquals(h.reloader.current().config.log_prompts, true);
});

Deno.test("reload — undoing a bad edit clears it too", async () => {
    const h = harness();

    h.save(new Error("bad"));
    await h.reloader.reload();

    h.save(testConfig());

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_UNCHANGED);
    assertEquals(h.reloader.status().declined, null);
    assertEquals(h.said, [
        "✅ Config on disk matches the running config again.",
    ]);
});

Deno.test("reload — a restart-only field declines it all", async () => {
    const h = harness();
    const before = h.reloader.current();

    //  The catalog edit rides with a port change, so neither lands.
    h.save(testConfig({
        listen_port: 11436,
        global_default_model: "model-b",
    }));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_DECLINED);
    assertStringIncludes(got.reason, "listen_port changed");
    assertStringIncludes(got.reason, "saxby service restart");
    assert(h.reloader.current() === before);
    assertEquals(h.warmed, []);
});

Deno.test("reload — every restart-only field is named", async () => {
    const h = harness();

    h.save(testConfig({
        listen_host: "0.0.0.0",
        log_path: "/elsewhere.db",
        memory: { margin_gib: 4 },
    }));

    const got = await h.reloader.reload();

    assertStringIncludes(
        got.reason,
        "listen_host, memory, log_path changed, and those need a restart",
    );
});

Deno.test("reload — a failed follow-up is not a decline", async () => {
    const h = harness({
        onApply: () => {
            throw new Error("broker said no");
        },
    });

    h.save(testConfig({ log_prompts: true }));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_APPLIED);
    assertEquals(h.reloader.status().declined, null);
    assertStringIncludes(h.warned[0], "broker said no");
    assertStringIncludes(h.warned[0], "Restart");
});

//  =====================================================================
//  Tier 3
//  =====================================================================

Deno.test("tier 3 — untouched exemplars reuse the vectors held", async () => {
    const semantic = { candidates: ["held"] };

    const h = harness({
        config: testConfig({ semantic: SEMANTIC_BLOCK }),
        semantic,
    });

    h.save(testConfig({ semantic: SEMANTIC_BLOCK, log_prompts: true }));

    await h.reloader.reload();

    assertEquals(h.warmed, []);
    assert(h.reloader.current().semantic === semantic);
});

Deno.test("tier 3 — a new exemplar is embedded before the swap", async () => {
    const h = harness({
        config: testConfig({ semantic: SEMANTIC_BLOCK }),
        semantic: { candidates: ["held"] },
    });

    const next = testConfig({ semantic: SEMANTIC_BLOCK });

    next.personas.coder.exemplars = ["refactor this", "the loop runs twice"];
    h.save(next);

    await h.reloader.reload();

    assertEquals(h.warmed.length, 1);
    assertEquals(
        h.reloader.current().semantic.builtFor.personas.coder.exemplars,
        ["refactor this", "the loop runs twice"],
    );
});

Deno.test("tier 3 — a dead embedder declines, not disables", async () => {
    const semantic = { candidates: ["held"] };

    const h = harness({
        config: testConfig({ semantic: SEMANTIC_BLOCK }),
        semantic,
    });

    const next = testConfig({ semantic: SEMANTIC_BLOCK });

    next.personas.coder.exemplars = ["something new"];
    h.save(next);
    h.failWarm(new Error("connection refused"));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_DECLINED);
    assertStringIncludes(got.reason, "connection refused");
    assert(h.reloader.current().semantic === semantic);
});

Deno.test("tier 3 — already off, a dead embedder costs nothing", async () => {
    //  The config asks for Tier 3, but the boot could not warm it.
    const h = harness({
        config: testConfig({ semantic: SEMANTIC_BLOCK }),
        semantic: null,
    });

    h.save(testConfig({ semantic: SEMANTIC_BLOCK, log_prompts: true }));
    h.failWarm(new Error("connection refused"));

    const got = await h.reloader.reload();

    assertEquals(got.outcome, RELOAD_APPLIED);
    assertEquals(h.reloader.current().semantic, null);
    assertStringIncludes(h.warned[0], "continuing without it");
});

Deno.test("tier 3 — off at boot, it comes back on a later save", async () => {
    const h = harness({
        config: testConfig({ semantic: SEMANTIC_BLOCK }),
        semantic: null,
    });

    h.save(testConfig({ semantic: SEMANTIC_BLOCK, log_prompts: true }));

    await h.reloader.reload();

    assert(h.reloader.current().semantic !== null);
});

//  =====================================================================
//  Order
//  =====================================================================

Deno.test("reload — two reloads run one after the other", async () => {
    const h = harness();

    h.save(testConfig({ log_prompts: true }));

    const first = h.reloader.reload();
    const second = h.reloader.reload();

    assertEquals((await first).outcome, RELOAD_APPLIED);
    assertEquals((await second).outcome, RELOAD_UNCHANGED);
    assertEquals(h.applied.length, 1);
});

Deno.test("listChangedFields — a field added or removed is listed", () => {
    const running = testConfig();
    const next = testConfig({ semantic: SEMANTIC_BLOCK });

    delete next.log_path;

    assertEquals(listChangedFields(running, next), ["log_path", "semantic"]);
});
