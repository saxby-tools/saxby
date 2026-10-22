//  =====================================================================
//  GET /shuntd/v1/status  —  which shuntd is this?
//  =====================================================================
//  Any process can hold a port, and two instances can be configured
//  for the same one. This answers "which instance is on this port,
//  and which process do I stop" for `shunt instance list`, the
//  port-clash message at boot, and `shunt probe`.
//
//  Answered from memory alone: no upstream call, no config read.
//  `instance` is null for the default instance. `version` answers
//  "which build is production running" once it runs a compiled
//  binary; packages are versioned in lockstep, so this one speaks for
//  the release.

import packageConfig from "../../../../deno.json" with { type: "json" };

export function registerStatusRoutes(app) {
    app.get("/shuntd/v1/status", (c) => {
        const config = c.get("config");

        return c.json({
            instance: c.get("instance"),
            port: config.listen_port,
            pid: Deno.pid,
            version: packageConfig.version,
        });
    });
}
