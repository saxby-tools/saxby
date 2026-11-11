import { assertEquals, assertStringIncludes } from "@std/assert";
import {
    announceNeighbours,
    describeNeighbour,
    findNeighbours,
} from "./neighbours.js";

//  =====================================================================
//  Harness
//  =====================================================================
//  The three core calls are faked: the folder list, each instance's
//  config and the status probe. No folder is read and no port is
//  asked.
//
//    configs   instance name -> its config, or an Error to throw
//    holders   instance name -> what its port answers, or null

const DEFAULT_PORT = 11435;
const DEV_PORT = 11436;
const LAB_PORT = 11437;

const DEFAULT_CONFIG = { listen_host: "127.0.0.1", listen_port: DEFAULT_PORT };
const DEV_CONFIG = { listen_host: "127.0.0.1", listen_port: DEV_PORT };
const LAB_CONFIG = { listen_host: "127.0.0.1", listen_port: LAB_PORT };

function harness({ instance, names, configs, holders }) {
    const asked = [];

    return {
        asked,
        deps: {
            instance,
            list: () => Promise.resolve(names),
            load: (name) => {
                const config = configs.get(name);

                if (config instanceof Error) {
                    return Promise.reject(config);
                }

                return Promise.resolve(config);
            },
            fetchStatus: (_config, name) => {
                asked.push(name);

                return Promise.resolve(holders.get(name) ?? null);
            },
        },
    };
}

Deno.test("neighbours — one other instance answering is named", async () => {
    const { deps } = harness({
        instance: null,
        names: [null, "dev"],
        configs: new Map([[null, DEFAULT_CONFIG], ["dev", DEV_CONFIG]]),
        holders: new Map([["dev", {
            instance: "dev",
            port: DEV_PORT,
            pid: 7,
        }]]),
    });

    assertEquals(await findNeighbours(deps), [
        { name: "dev", port: DEV_PORT },
    ]);
});

Deno.test("neighbours — none answering prints nothing", async () => {
    const lines = [];
    const { deps } = harness({
        instance: null,
        names: [null, "dev", "lab"],
        configs: new Map([
            [null, DEFAULT_CONFIG],
            ["dev", DEV_CONFIG],
            ["lab", LAB_CONFIG],
        ]),
        holders: new Map(),
    });

    await announceNeighbours(deps, (line) => lines.push(line));

    assertEquals(lines, []);
});

Deno.test("neighbours — an unreadable config is skipped", async () => {
    const { deps, asked } = harness({
        instance: null,
        names: [null, "dev", "lab"],
        configs: new Map([
            [null, DEFAULT_CONFIG],
            ["dev", new Error("❌ No config found")],
            ["lab", LAB_CONFIG],
        ]),
        holders: new Map([["lab", {
            instance: "lab",
            port: LAB_PORT,
            pid: 9,
        }]]),
    });

    assertEquals(await findNeighbours(deps), [
        { name: "lab", port: LAB_PORT },
    ]);
    assertEquals(asked, ["lab"]);
});

Deno.test("neighbours — a named boot names the default one", async () => {
    const lines = [];
    const { deps, asked } = harness({
        instance: "dev",
        names: [null, "dev"],
        configs: new Map([[null, DEFAULT_CONFIG], ["dev", DEV_CONFIG]]),
        holders: new Map([
            [null, { instance: null, port: DEFAULT_PORT, pid: 5 }],
            ["dev", { instance: "dev", port: DEV_PORT, pid: 7 }],
        ]),
    });

    await announceNeighbours(deps, (line) => lines.push(line));

    //  The booting instance is not its own neighbour, so dev's port is
    //  never asked.
    assertEquals(asked, [null]);
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0], "The default instance also runs");
    assertStringIncludes(lines[0], `port ${DEFAULT_PORT}`);
    assertStringIncludes(lines[0], "docs/memory-broker.md#limits");
});

Deno.test("neighbours — a port held by another is not it", async () => {
    //  The dev config names lab's port. What answers there is lab,
    //  which gets its own line from its own config; dev is stopped.
    const { deps } = harness({
        instance: null,
        names: [null, "dev", "lab"],
        configs: new Map([
            [null, DEFAULT_CONFIG],
            ["dev", LAB_CONFIG],
            ["lab", LAB_CONFIG],
        ]),
        holders: new Map([
            ["dev", { instance: "lab", port: LAB_PORT, pid: 9 }],
            ["lab", { instance: "lab", port: LAB_PORT, pid: 9 }],
        ]),
    });

    assertEquals(await findNeighbours(deps), [
        { name: "lab", port: LAB_PORT },
    ]);
});

Deno.test("neighbours — a failing probe is silent", async () => {
    const { deps } = harness({
        instance: null,
        names: [null, "dev"],
        configs: new Map([[null, DEFAULT_CONFIG], ["dev", DEV_CONFIG]]),
        holders: new Map(),
    });

    deps.fetchStatus = () => Promise.reject(new Error("socket closed"));

    assertEquals(await findNeighbours(deps), []);
});

Deno.test("neighbours — the line says what the gap is", () => {
    const line = describeNeighbour({ name: "dev", port: DEV_PORT });

    assertEquals(
        line,
        `ℹ️  The dev instance also runs on this machine ` +
            `(port ${DEV_PORT}). ` +
            `A job reserved there is invisible to this broker ` +
            `(docs/memory-broker.md#limits).`,
    );
});
