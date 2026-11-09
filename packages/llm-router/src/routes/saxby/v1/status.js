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
//
//  `config` answers "is the file on disk what is running?". saxbyd
//  applies a saved config live, and keeps the old one when it cannot
//  (config/reload.js). The person who saved the file is looking at an
//  editor, not at the daemon's log, so the reason is kept here for
//  `saxby status` to print:
//
//    loaded_at     when the running config was read
//    declined      null, or { at, reason } for an edit not applied
//    watch_error   null, or why edits are no longer picked up

import packageConfig from "../../../../deno.json" with { type: "json" };

export function registerStatusRoutes(app) {
    app.get("/saxby/v1/status", (c) => {
        const config = c.get("config");
        const readConfigState = c.get("configState");

        return c.json({
            instance: c.get("instance"),
            port: config.listen_port,
            pid: Deno.pid,
            version: packageConfig.version,
            config: readConfigState(),
        });
    });
}
