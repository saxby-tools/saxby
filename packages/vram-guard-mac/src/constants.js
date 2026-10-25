//  =====================================================================
//  Install locations
//  =====================================================================
//  Shared by install, uninstall and status so the label is spelled in
//  one place. The log path is ALSO hard-coded in vram-guard-mac.sh,
//  which cannot import this file — change both together.

import { SERVICE_PREFIX } from "@saxby/core";

export const LABEL = `${SERVICE_PREFIX}.vram-guard-mac`;

export const PLIST_DESTINATION = `/Library/LaunchDaemons/${LABEL}.plist`;

export const DAEMON_DIR = "/usr/local/libexec/saxby";
export const DAEMON_SCRIPT_DESTINATION = `${DAEMON_DIR}/vram-guard-mac.sh`;

export const LOG_OUT = `/var/log/${LABEL}.out.log`;
export const LOG_ERROR = `/var/log/${LABEL}.error.log`;
