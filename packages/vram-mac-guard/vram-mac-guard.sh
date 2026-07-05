#!/usr/bin/env bash

# Explicitly set PATH for the launchd root environment
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

LOG_FILE="/var/log/vram-mac-guard.log"

# ---------------------------------------------------------
# 1. ARCHITECTURE GUARDRAIL
# ---------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]] || [[ "$(uname -m)" != "arm64" ]]; then
    echo "$(date) - FATAL: vram-mac-guard requires macOS on Apple Silicon (arm64). Exiting." >>"$LOG_FILE"
    exit 1
fi

# ---------------------------------------------------------
# 2. DYNAMIC MEMORY CALCULATION
# ---------------------------------------------------------
# Get total physical RAM in bytes and convert to MB
TOTAL_RAM_BYTES=$(sysctl -n hw.memsize)
TOTAL_RAM_MB=$((TOTAL_RAM_BYTES / 1024 / 1024))

# Baseline Heuristics:
# Safe is ~75% of total RAM (macOS default behavior)
# Heavy is ~86% of total RAM (Aggressive ML workload ceiling)
CALC_SAFE_MB=$((TOTAL_RAM_MB * 75 / 100))
CALC_HEAVY_MB=$((TOTAL_RAM_MB * 86 / 100))

# ---------------------------------------------------------
# 3. ENVIRONMENT OVERRIDES
# ---------------------------------------------------------
CONFIG_FILE="/etc/vram-mac-guard.env"
if [ -f "$CONFIG_FILE" ]; then
    # shellcheck source=/dev/null
    source "$CONFIG_FILE"
fi

SAFE_MB=${VRAM_GUARD_SAFE_MB:-$CALC_SAFE_MB}
HEAVY_MB=${VRAM_GUARD_HEAVY_MB:-$CALC_HEAVY_MB}

# Safety Clamp: Never let the script starve the macOS kernel
if [ "$HEAVY_MB" -lt "$SAFE_MB" ]; then
    HEAVY_MB=$SAFE_MB
fi

echo "$(date) - vram-mac-guard started. Total RAM: ${TOTAL_RAM_MB}MB | Safe: ${SAFE_MB}MB | Heavy: ${HEAVY_MB}MB" >>"$LOG_FILE"

# ---------------------------------------------------------
# 4. DAEMON LOOP
# ---------------------------------------------------------
LAST_STATE=""

while true; do
    # Check if Ollama has models loaded
    if ollama ps 2>/dev/null | grep -q -E "GB|MB"; then
        STATE="heavy"
    else
        STATE="safe"
    fi

    # Only trigger sysctl if the state actually changed
    if [ "$STATE" != "$LAST_STATE" ]; then
        if [ "$STATE" = "heavy" ]; then
            sysctl iogpu.wired_limit_mb="$HEAVY_MB"
            echo "$(date) - Models detected. Raised limit to ${HEAVY_MB}MB" >>"$LOG_FILE"
        else
            sysctl iogpu.wired_limit_mb="$SAFE_MB"
            echo "$(date) - Models idled. Lowered limit to ${SAFE_MB}MB" >>"$LOG_FILE"
        fi
        LAST_STATE="$STATE"
    fi

    sleep 5
done
