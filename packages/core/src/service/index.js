//  =====================================================================
//  Service naming
//  =====================================================================
//  Lives in core because every package that installs something into
//  launchd builds its label from this prefix: the VRAM guard today,
//  the router's service adapters next. Reverse-DNS from saxby.tools.

/**
 * The start of every service label: `tools.saxby.router`,
 * `tools.saxby.router.dev`, `tools.saxby.vram-guard-mac`.
 */
export const SERVICE_PREFIX = "tools.saxby";
