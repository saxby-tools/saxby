//  =====================================================================
//  Install locations
//  =====================================================================
//  Shared by install, uninstall and status so the label is spelled in
//  one place. The log path is ALSO hard-coded in vram-mac-guard.sh,
//  which cannot import this file — change both together.

import { SERVICE_PREFIX } from "@shuntd/core";

export const LABEL = `${SERVICE_PREFIX}.vram-mac-guard`;

export const PLIST_DESTINATION = `/Library/LaunchDaemons/${LABEL}.plist`;

export const DAEMON_DIR = "/usr/local/libexec/shuntd";
export const DAEMON_SCRIPT_DESTINATION = `${DAEMON_DIR}/vram-mac-guard.sh`;

export const LOG_OUT = `/var/log/${LABEL}.out.log`;
export const LOG_ERROR = `/var/log/${LABEL}.error.log`;
