//  =====================================================================
//  /saxby/v1/reservations  —  the memory broker's API
//  =====================================================================
//  `saxby reserve` is the client; docs/memory-broker.md has the shapes.
//
//    POST   /saxby/v1/reservations              ask; held open while
//                                               it waits
//    POST   /saxby/v1/reservations/:id/heartbeat check in
//    DELETE /saxby/v1/reservations/:id           release
//    GET    /saxby/v1/reservations              the budget and ledger
//
//  Behind the security guard like every route, so only local,
//  non-browser clients reach it. Numbers are whole bytes; messages use
//  GiB.

import { gibToBytes } from "@saxby/core";
import {
    CODE_ABANDONED,
    CODE_LIVENESS,
    CODE_MEMORY,
    CODE_PID,
} from "../../../memory/broker.js";
import { isPid } from "../../../memory/liveness.js";

const BASE_PATH = "/saxby/v1/reservations";

//  Long enough for a command's name, short enough to keep the log
//  narrow.
const LABEL_MAX_LENGTH = 64;

//  Ids are crypto.randomUUID(); a re-registering wrapper sends its own
//  back, so only that shape is accepted.
const ID_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

const MS_PER_S = 1000;

//  The client left while waiting. Nginx's code; the chat route uses it
//  for the same case.
const STATUS_CLIENT_GONE = 499;

const STATUS_BY_CODE = {
    [CODE_MEMORY]: 503,
    [CODE_LIVENESS]: 503,
    [CODE_PID]: 400,
};

//  ---------------------------------------------------------------------
//  Views
//  ---------------------------------------------------------------------
//  The broker works in camelCase; the API speaks snake_case, like the
//  explain endpoint.

function jobView(entry) {
    return {
        id: entry.id,
        bytes: entry.bytes,
        label: entry.label,
        pid: entry.pid,
        child_pid: entry.childPid,
        created_at: entry.createdAt,
        last_heartbeat_at: entry.lastHeartbeatAt,
    };
}

function holdView(entry) {
    return {
        id: entry.id,
        bytes: entry.bytes,
        model: entry.model,
        request_id: entry.requestId,
        created_at: entry.createdAt,
    };
}

function budgetView(budget) {
    return {
        ceiling_bytes: budget.ceilingBytes,
        ceiling_source: budget.ceilingSource,
        margin_bytes: budget.marginBytes,
        pinned_bytes: budget.pinnedBytes,
        loaded_bytes: budget.loadedBytes,
        reserved_bytes: budget.reservedBytes,
        free_bytes: budget.freeBytes,
        pinned: budget.pinned,
        loaded: budget.loaded,
        unknowns: budget.unknowns,
        used_bytes: budget.usedBytes,
        used_source: budget.usedSource,
    };
}

//  OpenAI's error shape, which the chat route uses too. A 503 is the
//  server's state, not a fault in the request.
function errorBody(code, message, status = 400) {
    const type = status >= 500 ? "server_error" : "invalid_request_error";

    return { error: { message, type, code } };
}

//  ---------------------------------------------------------------------
//  Reading requests
//  ---------------------------------------------------------------------

async function readJson(c) {
    try {
        return await c.req.json();
    } catch {
        return null;
    }
}

function readLabel(value) {
    if (value === undefined) {
        return { label: null };
    }

    if (typeof value !== "string") {
        return { problem: "'label' must be a string" };
    }

    const label = value.trim();

    if (label.length > LABEL_MAX_LENGTH) {
        return {
            problem: `'label' must be at most ${LABEL_MAX_LENGTH} characters`,
        };
    }

    return { label: label || null };
}

function readChildPid(value) {
    if (value === undefined) {
        return { childPid: null };
    }

    if (value === null) {
        return { childPid: null };
    }

    if (!isPid(value)) {
        return { problem: "'child_pid' must be a positive whole number" };
    }

    return { childPid: value };
}

/**
 * Checks a POST body. Returns a problem sentence, or the request.
 */
function readJobRequest(body) {
    if (typeof body !== "object" || body === null) {
        return { problem: "Body must be a JSON object." };
    }

    if (typeof body.gib !== "number" || !(body.gib > 0)) {
        return { problem: "'gib' must be a number greater than 0" };
    }

    if (!Number.isFinite(body.gib)) {
        return { problem: "'gib' must be finite" };
    }

    if (!isPid(body.pid)) {
        return { problem: "'pid' must be a positive whole number" };
    }

    const label = readLabel(body.label);

    if (label.problem) {
        return label;
    }

    if (body.timeout_s !== undefined) {
        if (typeof body.timeout_s !== "number" || !(body.timeout_s >= 0)) {
            return { problem: "'timeout_s' must be a number >= 0" };
        }
    }

    const child = readChildPid(body.child_pid);

    if (child.problem) {
        return child;
    }

    if (body.reregister !== undefined) {
        if (typeof body.reregister !== "boolean") {
            return { problem: "'reregister' must be true or false" };
        }
    }

    if (body.reregister === true) {
        if (typeof body.id !== "string" || !ID_PATTERN.test(body.id)) {
            return { problem: "re-registering needs the reservation's 'id'" };
        }
    }

    return {
        request: {
            id: body.id,
            bytes: gibToBytes(body.gib),
            pid: body.pid,
            childPid: child.childPid,
            label: label.label,
            timeoutMs: body.timeout_s === undefined
                ? undefined
                : body.timeout_s * MS_PER_S,
            reregister: body.reregister === true,
        },
    };
}

//  ---------------------------------------------------------------------
//  Routes
//  ---------------------------------------------------------------------

function admittedBody(broker, result) {
    return {
        reservation: jobView(result.reservation),
        heartbeat_interval_s: broker.heartbeatIntervalS,
        ceiling_bytes: result.budget?.ceilingBytes ?? null,
        waited_ms: result.waitedMs ?? 0,
    };
}

async function create(c) {
    const broker = c.get("broker");
    const parsed = readJobRequest(await readJson(c));

    if (parsed.problem) {
        return c.json(errorBody("invalid_reservation", parsed.problem), 400);
    }

    const request = parsed.request;

    const result = request.reregister
        ? await broker.reregister(request)
        : await broker.reserve({ ...request, signal: c.req.raw.signal });

    if (result.admitted) {
        return c.json(admittedBody(broker, result), 201);
    }

    if (result.code === CODE_ABANDONED) {
        return c.body(null, STATUS_CLIENT_GONE);
    }

    const status = STATUS_BY_CODE[result.code] ?? 503;
    const body = errorBody(result.code, result.reason, status);

    if (result.budget) {
        body.budget = budgetView(result.budget);
    }

    return c.json(body, status);
}

async function heartbeat(c) {
    const broker = c.get("broker");
    const body = (await readJson(c)) ?? {};
    const child = readChildPid(body.child_pid);

    if (child.problem) {
        return c.json(errorBody("invalid_reservation", child.problem), 400);
    }

    const entry = broker.heartbeat(c.req.param("id"), child.childPid);

    if (!entry) {
        return c.json(
            errorBody(
                "reservation_unknown",
                "No such reservation. saxbyd may have restarted; " +
                    "register again with 'reregister': true.",
            ),
            404,
        );
    }

    return c.json({ reservation: jobView(entry) });
}

function release(c) {
    const entry = c.get("broker").release(c.req.param("id"));

    if (!entry) {
        return c.json(
            errorBody("reservation_unknown", "No such reservation."),
            404,
        );
    }

    return c.json({ reservation: jobView(entry) });
}

async function list(c) {
    const snapshot = await c.get("broker").snapshot();

    return c.json({
        budget: budgetView(snapshot.budget),
        reservations: snapshot.jobs.map(jobView),
        holds: snapshot.holds.map(holdView),
    });
}

export function registerReservationRoutes(app) {
    app.get(BASE_PATH, list);
    app.post(BASE_PATH, create);
    app.post(`${BASE_PATH}/:id/heartbeat`, heartbeat);
    app.delete(`${BASE_PATH}/:id`, release);
}
