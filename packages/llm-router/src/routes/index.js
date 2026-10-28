import { registerModelsRoutes } from "./v1/models.js";
import { registerChatRoutes } from "./v1/chat.js";
import { registerExplainRoutes } from "./saxby/v1/explain.js";
import { registerStatusRoutes } from "./saxby/v1/status.js";
import { registerReservationRoutes } from "./saxby/v1/reservations.js";

/**
 * Master route registry.
 * Aggregates all route registration functions.
 * @param {import("hono").Hono} app
 */
export function registerRoutes(app) {
    registerModelsRoutes(app);
    registerChatRoutes(app);
    registerExplainRoutes(app);
    registerStatusRoutes(app);
    registerReservationRoutes(app);
}
