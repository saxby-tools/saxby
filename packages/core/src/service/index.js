//  =====================================================================
//  Service naming
//  =====================================================================
//  Lives in core because every package that installs something into
//  launchd builds its label from this prefix: the VRAM guard today,
//  the router's service adapters next. Reverse-DNS from saxby.tools.

export const SERVICE_PREFIX = "tools.saxby";
