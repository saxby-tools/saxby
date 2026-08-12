import { registerModelsRoutes } from "./v1/models.js";
import { registerChatRoutes } from "./v1/chat.js";

/**
 * Master route registry.
 * Aggregates all route registration functions.
 * @param {import("hono").Hono} app
 */
export function registerRoutes(app) {
    registerModelsRoutes(app);
    registerChatRoutes(app);
}
