//  =====================================================================
//  Install locations
//  =====================================================================
//  Shared by install, uninstall and status so the label is spelled in
//  one place. The log path is ALSO hard-coded in vram-guard-mac.sh,
//  which cannot import this file — change both together.

import { SERVICE_PREFIX } from "@saxby/core";

/**
 * The LaunchDaemon's label, `tools.saxby.vram-guard-mac`. One name for
 * the package, the command, the script and the plist.
 */
export const LABEL = `${SERVICE_PREFIX}.vram-guard-mac`;

/** Where the plist is installed: the system LaunchDaemons folder. */
export const PLIST_DESTINATION = `/Library/LaunchDaemons/${LABEL}.plist`;

/**
 * The folder the guard script is installed to. Under /usr/local, not
 * /etc, since it is a program; its override file lives under
 * /usr/local/etc.
 */
export const DAEMON_DIR = "/usr/local/libexec/saxby";

/** The installed guard script, which the plist runs at boot. */
export const DAEMON_SCRIPT_DESTINATION = `${DAEMON_DIR}/vram-guard-mac.sh`;

/** The daemon's stdout log. The script hard-codes the same path. */
export const LOG_OUT = `/var/log/${LABEL}.out.log`;

/** The daemon's stderr log, beside LOG_OUT. */
export const LOG_ERROR = `/var/log/${LABEL}.error.log`;
