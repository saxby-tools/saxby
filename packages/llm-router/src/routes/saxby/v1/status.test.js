import { assertEquals } from "@std/assert";
import { Hono } from "@hono/hono";
import { registerStatusRoutes } from "./status.js";

//  Served by Hono in memory: no port, no config file. main.js sets the
//  same context values from the reloader.

function app(configState) {
    const hono = new Hono();

    hono.use("*", async (c, next) => {
        c.set("config", { listen_port: 11436 });
        c.set("configState", () => configState);
        c.set("instance", "dev");
        await next();
    });

    registerStatusRoutes(hono);

    return hono;
}

Deno.test("status — says which saxbyd this is", async () => {
    const response = await app({
        loaded_at: "2026-11-09T12:00:00.000Z",
        declined: null,
        watch_error: null,
    }).request("/saxby/v1/status");

    const body = await response.json();

    assertEquals(body.instance, "dev");
    assertEquals(body.port, 11436);
    assertEquals(body.pid, Deno.pid);
    assertEquals(typeof body.version, "string");
});

Deno.test("status — carries an edit that was not applied", async () => {
    const state = {
        loaded_at: "2026-11-09T12:00:00.000Z",
        declined: {
            at: "2026-11-09T12:05:00.000Z",
            reason: "listen_port changed, and that needs a restart.",
        },
        watch_error: null,
    };

    const response = await app(state).request("/saxby/v1/status");
    const body = await response.json();

    assertEquals(body.config, state);
});
