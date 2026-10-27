#!/usr/bin/env bash

#  =====================================================================
#  vram-guard-mac
#  =====================================================================
#  Sets the GPU wired-memory ceiling once, at boot, then exits.
#
#  The ceiling is a maximum, not a reservation: raising it takes
#  nothing from macOS until a model is loaded. Backends read it once,
#  when they start, so it must already be high by then and must never
#  drop while they run. A LaunchDaemon starts before anyone logs in,
#  so a backend started by a login agent reads the raised value.
#
#  The script knows nothing about any backend, on purpose.

# ---------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------
# Explicitly set PATH for the launchd root environment
PATH=/usr/bin:/bin:/usr/sbin:/sbin

# Must match LOG_OUT in src/constants.js
LOG_FILE="/var/log/tools.saxby.vram-guard-mac.out.log"

CONFIG_FILE="/usr/local/etc/saxby/vram-guard-mac.env"

# Share of RAM the GPU may wire. macOS's own default varies by release
# and machine: 107.5 GiB of 128 (about 84%) on macOS 26 on an M5 Max,
# so 86% barely raises it there. Measure before relying on either
# number; the override file can also LOWER the ceiling, which keeps
# memory a runaway GPU job can never wire.
DEFAULT_PERCENT=86

log() {
    echo "$(date) - $*" >>"$LOG_FILE"
}

# ---------------------------------------------------------
# 1. ARCHITECTURE GUARDRAIL
# ---------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
    log "FATAL: vram-guard-mac requires macOS. Exiting."
    exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
    log "FATAL: vram-guard-mac requires Apple Silicon. Exiting."
    exit 1
fi

# ---------------------------------------------------------
# 2. DEFAULT CEILING
# ---------------------------------------------------------
TOTAL_RAM_BYTES=$(sysctl -n hw.memsize)
TOTAL_RAM_MB=$((TOTAL_RAM_BYTES / 1024 / 1024))

LIMIT_MB=$((TOTAL_RAM_MB * DEFAULT_PERCENT / 100))

# ---------------------------------------------------------
# 3. ENVIRONMENT OVERRIDE
# ---------------------------------------------------------
# The override file is sourced AS ROOT, so it is trusted only when
# root owns it and nobody else can write to it. /usr/local is
# user-writable on some Homebrew setups. stat does not follow
# symlinks, so a link planted by a user fails the owner check too.
load_overrides() {
    if [ ! -f "$CONFIG_FILE" ]; then
        return
    fi

    if [ "$(stat -f '%u' "$CONFIG_FILE")" != "0" ]; then
        log "WARNING: $CONFIG_FILE is not owned by root. Ignoring it."
        return
    fi

    if [ -n "$(find "$CONFIG_FILE" -perm +022)" ]; then
        log "WARNING: $CONFIG_FILE is writable by non-root users." \
            "Ignoring it."
        return
    fi

    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
}

# A ceiling above physical RAM means nothing, and a value that is not
# a whole number would reach sysctl as garbage. Either one falls back
# to the default rather than failing, so the guard still does its job.
apply_override() {
    if [ -z "$VRAM_GUARD_LIMIT_MB" ]; then
        return
    fi

    if [[ ! "$VRAM_GUARD_LIMIT_MB" =~ ^[0-9]+$ ]]; then
        log "WARNING: VRAM_GUARD_LIMIT_MB is not a whole number." \
            "Using ${LIMIT_MB}MB."
        return
    fi

    if [ "$VRAM_GUARD_LIMIT_MB" -gt "$TOTAL_RAM_MB" ]; then
        log "WARNING: VRAM_GUARD_LIMIT_MB is more than total RAM." \
            "Using ${LIMIT_MB}MB."
        return
    fi

    LIMIT_MB=$VRAM_GUARD_LIMIT_MB
}

load_overrides
apply_override

# ---------------------------------------------------------
# 4. SET THE CEILING
# ---------------------------------------------------------
if ! sysctl iogpu.wired_limit_mb="$LIMIT_MB" >/dev/null; then
    log "FATAL: could not set iogpu.wired_limit_mb to ${LIMIT_MB}MB."
    exit 1
fi

log "Total RAM: ${TOTAL_RAM_MB}MB | Ceiling set to ${LIMIT_MB}MB"
