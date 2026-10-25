//  =====================================================================
//  GET /saxby/v1/status  —  which saxbyd is this?
//  =====================================================================
//  Any process can hold a port, and two instances can be configured
//  for the same one. This answers "which instance is on this port,
//  and which process do I stop" for `saxby instance list`, the
//  port-clash message at boot, and `saxby probe`.
//
//  Answered from memory alone: no upstream call, no config read.
//  `instance` is null for the default instance. `version` answers
//  "which build is the service running" once it runs a compiled
//  binary; packages are versioned in lockstep, so this one speaks for
//  the release.

import packageConfig from "../../../../deno.json" with { type: "json" };

export function registerStatusRoutes(app) {
    app.get("/saxby/v1/status", (c) => {
        const config = c.get("config");

        return c.json({
            instance: c.get("instance"),
            port: config.listen_port,
            pid: Deno.pid,
            version: packageConfig.version,
        });
    });
}
