import { Command } from "@cliffy/command";
import { findServiceAdapter } from "../../services/index.js";
import {
    fetchShuntdStatus,
    getHomeDir,
    getInstanceDir,
    listInstances,
    loadConfig,
} from "@shuntd/core";

const COLUMNS = [
    "NAME",
    "PORT",
    "STATE",
    "PID",
    "VERSION",
    "SERVICE",
    "DIRECTORY",
];
const GAP = 2;

//  Shortens paths for display only; never feed the result back in.
function tildify(path) {
    const home = getHomeDir();

    if (!home) {
        return path;
    }

    if (!path.startsWith(home)) {
        return path;
    }

    return `~${path.slice(home.length)}`;
}

//  "installed" means the service file exists; STATE already says
//  whether something is answering.
async function describeService(name) {
    const adapter = findServiceAdapter();

    if (!adapter) {
        return "-";
    }

    const service = await adapter.status(name);

    return service.installed ? "installed" : "-";
}

/**
 * One row per instance. "running" means the shuntd on the configured
 * port says it IS this instance. A port held by another instance is
 * reported as blocked, since starting this one would fail.
 */
async function describeInstance(name) {
    const row = {
        name: name ?? "default",
        port: "-",
        state: "error",
        pid: "-",
        version: "-",
        service: await describeService(name),
        directory: tildify(getInstanceDir(name)),
        error: null,
    };

    let config;

    try {
        config = await loadConfig(name);
    } catch (err) {
        row.error = err.message.split("\n")[0];
        return row;
    }

    row.port = String(config.listen_port);

    const holder = await fetchShuntdStatus(config.listen_port);

    if (!holder) {
        row.state = "stopped";
        return row;
    }

    row.pid = String(holder.pid);

    if (holder.instance !== name) {
        row.state = "blocked";
        row.error = `port ${row.port} is held by instance ` +
            `'${holder.instance ?? "default"}'`;
        return row;
    }

    row.state = "running";
    row.version = holder.version ?? "-";

    return row;
}

function printTable(rows) {
    const cells = rows.map((row) => [
        row.name,
        row.port,
        row.state,
        row.pid,
        row.version,
        row.service,
        row.directory,
    ]);

    const widths = COLUMNS.map((title, i) =>
        Math.max(title.length, ...cells.map((line) => line[i].length))
    );

    const render = (line) =>
        line.map((cell, i) => cell.padEnd(widths[i] + GAP)).join("")
            .trimEnd();

    console.log(render(COLUMNS));

    for (const line of cells) {
        console.log(render(line));
    }
}

function printErrors(rows) {
    const failed = rows.filter((row) => row.error);

    if (failed.length === 0) {
        return;
    }

    console.log("");

    for (const row of failed) {
        console.log(`${row.name}: ${row.error}`);
    }
}

export const listCommand = new Command()
    .description("List instances with their ports and whether they run.")
    .action(async () => {
        const names = await listInstances();
        const rows = await Promise.all(names.map(describeInstance));

        printTable(rows);
        printErrors(rows);
    });
