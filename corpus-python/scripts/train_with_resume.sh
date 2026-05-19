#!/usr/bin/env bash
# Train Stage 1 with auto-resume on GPU hang. gfx1103 (Radeon 780M) firmware has
# observed HW Exception ("GPU Hang") under sustained load roughly every 1-2h. This
# wrapper restarts the training process when it exits non-zero, resuming from the
# latest step-* checkpoint.
#
# Usage:
#   HSA_OVERRIDE_GFX_VERSION=11.0.0 ./train_with_resume.sh [extra args passed to python -m mailwoman_train train]
#
# Stops when:
#   - python exits 0 (training reached max_steps)
#   - signal trap caught (SIGINT/SIGTERM)
#   - max-attempts reached (default 50, override via $MAX_ATTEMPTS)

set -u
MAX_ATTEMPTS="${MAX_ATTEMPTS:-50}"
LOG="${LOG:-/tmp/stage1-train.log}"
CONFIG="${CONFIG:-src/mailwoman_train/configs/stage1-coarse.yaml}"
EXTRA_ARGS=("$@")
ATTEMPT=0

trap 'echo "[wrapper] received signal, exiting"; exit 130' INT TERM

# First attempt — fresh start unless --resume is in extra args.
if [[ ! " ${EXTRA_ARGS[*]} " =~ " --resume " ]]; then
    echo "[wrapper] attempt 1: fresh start"
    python -u -m mailwoman_train train --config "$CONFIG" "${EXTRA_ARGS[@]}" >>"$LOG" 2>&1
    EXIT=$?
    ATTEMPT=1
    if [ "$EXIT" -eq 0 ]; then
        echo "[wrapper] training completed successfully on attempt 1"
        exit 0
    fi
    echo "[wrapper] attempt 1 exited with $EXIT — resuming"
fi

while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    echo "[wrapper] attempt $ATTEMPT: resume=auto"
    python -u -m mailwoman_train train --config "$CONFIG" --resume auto "${EXTRA_ARGS[@]}" >>"$LOG" 2>&1
    EXIT=$?
    if [ "$EXIT" -eq 0 ]; then
        echo "[wrapper] training completed successfully on attempt $ATTEMPT"
        exit 0
    fi
    echo "[wrapper] attempt $ATTEMPT exited with $EXIT; sleeping 15s then resuming"
    sleep 15
done

echo "[wrapper] MAX_ATTEMPTS=$MAX_ATTEMPTS reached, giving up"
exit 1
