#!/usr/bin/env bash
#
# ds-consult.sh — consult DeepSeek through the `pi` agent harness, safely.
#
# WHY THIS WRAPPER EXISTS
# -----------------------
# `pi` is a FULL coding agent (read/bash/edit/write/grep/find/ls), not a chat
# pipe. Invoked naively (`pi --print "<question>"`) it will:
#   - run an agentic tool loop on hard questions (unbounded runtime), and even
#     EDIT files in the working tree — during what was meant to be a "consult";
#   - on `deepseek-v4-pro` at the default `--thinking medium`, spend many
#     minutes producing a long reasoning trace with ZERO output in `--print`
#     (text) mode. That is the "pi hung ~1h with no output" we kept hitting and
#     working around with raw curl. It was never hung — just slow + silent.
#
# This wrapper bakes in the fixes we verified empirically (2026-06-08):
#   --no-tools          pure reasoning; no tool loop, no writes to the repo
#   -nc -ns -ne         isolated reviewer: ignore mailwoman AGENTS.md/skills/exts
#   --mode json | jq    structured output; extract the clean final answer
#   --session-id        robust stateful multi-turn (NOT `--continue` = "most
#                       recent session", which silently grabs the wrong one)
#   timeout             a slow turn can never hang the caller again
#   flash + low default deepseek-v4-flash --thinking low (~2-30s); escalate to
#                       --pro (deepseek-v4-pro --thinking medium) for depth
#
# USAGE
#   ds-consult.sh [options] "prompt"
#   ds-consult.sh [options] -f prompt.md
#   echo "prompt" | ds-consult.sh [options]
#
# OPTIONS
#   -c, --continue        Continue the most recent ds-consult conversation
#   -s, --session <id>    Use/resume a named conversation id
#   -n, --new             Force a fresh conversation (new random id)
#       --pro             Use deepseek-v4-pro (default: deepseek-v4-flash)
#       --thinking <lvl>  off|minimal|low|medium|high|xhigh (override default)
#       --tools-ro        Read-only explore profile: let DeepSeek read the repo
#                         itself (read,grep,find,ls + --approve). Slower; opt-in.
#       --timeout <sec>   Override the wall-clock timeout
#       --raw             Also keep the full JSON event log; print its path
#       --json            Emit the final message_end object (for scripting)
#   -f, --file <path>     Read the prompt from a file
#   -h, --help            This help
#
# The clean answer goes to STDOUT. Meta (model, elapsed, session, log) goes to
# STDERR, so capturing stdout yields just DeepSeek's reply.
#
set -euo pipefail

# ---- config -----------------------------------------------------------------
ENV_HOST="${DS_ENV_HOST:-$HOME/Projects/playpen/.env.host}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ds-consult"
SESSION_DIR="$CACHE_DIR/sessions"
LAST_PTR="$CACHE_DIR/last-session"

PROVIDER="deepseek"
MODEL="deepseek-v4-flash"
THINKING="low"
TIMEOUT=""          # resolved per-model below if unset
TOOLS_ARGS=(--no-tools)
SESSION_ID=""
WANT_CONTINUE=0
WANT_NEW=0
RAW=0
EMIT_JSON=0
PROMPT_FILE=""
declare -a REST=()

die() { printf 'ds-consult: %s\n' "$1" >&2; exit "${2:-1}"; }

# ---- arg parsing ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    -c|--continue) WANT_CONTINUE=1; shift ;;
    -n|--new)      WANT_NEW=1; shift ;;
    -s|--session)  SESSION_ID="${2:?--session needs an id}"; shift 2 ;;
    --pro)         MODEL="deepseek-v4-pro"; THINKING="medium"; shift ;;
    --thinking)    THINKING="${2:?--thinking needs a level}"; shift 2 ;;
    --tools-ro)    TOOLS_ARGS=(--tools read,grep,find,ls --approve); shift ;;
    --timeout)     TIMEOUT="${2:?--timeout needs seconds}"; shift 2 ;;
    --raw)         RAW=1; shift ;;
    --json)        EMIT_JSON=1; shift ;;
    -f|--file)     PROMPT_FILE="${2:?--file needs a path}"; shift 2 ;;
    -h|--help)     sed -n '2,55p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --)            shift; while [ $# -gt 0 ]; do REST+=("$1"); shift; done ;;
    -*)            die "unknown option: $1" ;;
    *)             REST+=("$1"); shift ;;
  esac
done

# Default timeout depends on the model (pro reasons longer).
if [ -z "$TIMEOUT" ]; then
  case "$MODEL" in
    *pro*) TIMEOUT=300 ;;
    *)     TIMEOUT=180 ;;
  esac
fi

# ---- resolve the prompt -----------------------------------------------------
PROMPT=""
if [ -n "$PROMPT_FILE" ]; then
  [ -r "$PROMPT_FILE" ] || die "cannot read prompt file: $PROMPT_FILE"
  PROMPT="$(cat "$PROMPT_FILE")"
elif [ "${#REST[@]}" -gt 0 ]; then
  PROMPT="${REST[*]}"
elif [ ! -t 0 ]; then
  PROMPT="$(cat)"
fi
[ -n "${PROMPT//[[:space:]]/}" ] || die "no prompt given (pass a string, -f FILE, or pipe stdin)"

# ---- resolve the API key ----------------------------------------------------
if [ -z "${DEEPSEEK_API_KEY:-}" ]; then
  [ -r "$ENV_HOST" ] || die "DEEPSEEK_API_KEY unset and $ENV_HOST not readable"
  DEEPSEEK_API_KEY="$(grep '^DEEPSEEK_API_KEY=' "$ENV_HOST" | cut -d= -f2-)"
  [ -n "$DEEPSEEK_API_KEY" ] || die "DEEPSEEK_API_KEY not found in $ENV_HOST"
fi
export DEEPSEEK_API_KEY

# ---- resolve the session id -------------------------------------------------
mkdir -p "$SESSION_DIR"
if [ "$WANT_NEW" -eq 1 ]; then
  SESSION_ID="consult-$(date +%Y%m%d-%H%M%S)-$$"
elif [ -n "$SESSION_ID" ]; then
  :                                   # explicit id wins
elif [ "$WANT_CONTINUE" -eq 1 ]; then
  [ -r "$LAST_PTR" ] || die "--continue: no previous conversation (run a first turn, or pass -s <id>)"
  SESSION_ID="$(cat "$LAST_PTR")"
else
  SESSION_ID="consult-$(date +%Y%m%d-%H%M%S)-$$"   # default: a fresh conversation
fi
printf '%s' "$SESSION_ID" > "$LAST_PTR"

# ---- run pi -----------------------------------------------------------------
TMP_JSON="$(mktemp "${TMPDIR:-/tmp}/ds-consult.XXXXXX.jsonl")"
TMP_ERR="$(mktemp "${TMPDIR:-/tmp}/ds-consult.XXXXXX.err")"
cleanup() { [ "$RAW" -eq 1 ] || rm -f "$TMP_JSON"; rm -f "$TMP_ERR"; }
trap cleanup EXIT

start=$(date +%s)
set +e
timeout "$TIMEOUT" pi \
  --provider "$PROVIDER" --model "$MODEL" --thinking "$THINKING" \
  "${TOOLS_ARGS[@]}" -nc -ns -ne \
  --session-dir "$SESSION_DIR" --session-id "$SESSION_ID" \
  --mode json -p "$PROMPT" \
  > "$TMP_JSON" 2> "$TMP_ERR"
rc=$?
set -e
elapsed=$(( $(date +%s) - start ))

# ---- handle failures --------------------------------------------------------
if [ "$rc" -eq 124 ]; then
  {
    echo "ds-consult: TIMED OUT after ${TIMEOUT}s (model=$MODEL thinking=$THINKING)."
    echo "  Try: scope the question smaller, drop to --thinking low, use flash (default),"
    echo "       or re-run with --timeout <bigger> if you genuinely need a long pro turn."
  } >&2
  exit 124
fi
if [ "$rc" -ne 0 ]; then
  echo "ds-consult: pi exited $rc. stderr:" >&2
  sed 's/^/  /' "$TMP_ERR" >&2 || true
  exit "$rc"
fi

# ---- extract the answer -----------------------------------------------------
# Detect an errored final turn (e.g. provider error / aborted).
stop_err="$(jq -rc 'select(.type=="message_end") | .message
            | select(.stopReason=="error" or .stopReason=="aborted")
            | (.errorMessage // .stopReason)' "$TMP_JSON" 2>/dev/null | tail -1 || true)"
if [ -n "$stop_err" ]; then
  echo "ds-consult: DeepSeek turn ended in error: $stop_err" >&2
  [ -s "$TMP_ERR" ] && sed 's/^/  /' "$TMP_ERR" >&2
  exit 1
fi

if [ "$EMIT_JSON" -eq 1 ]; then
  # Last assistant message_end object, for programmatic callers.
  jq -c 'select(.type=="message_end" and .message.role=="assistant") | .message' "$TMP_JSON" | tail -1
else
  ANSWER="$(jq -rc 'select(.type=="message_end" and .message.role=="assistant")
              | .message.content[]? | select(.type=="text") | .text' "$TMP_JSON" 2>/dev/null || true)"
  if [ -z "${ANSWER//[[:space:]]/}" ]; then
    echo "ds-consult: empty response (no text in final message). Raw stderr:" >&2
    [ -s "$TMP_ERR" ] && sed 's/^/  /' "$TMP_ERR" >&2
    echo "  Retry with a shorter prompt; if it persists, check the key:" >&2
    echo "    curl -s https://api.deepseek.com/v1/models -H \"Authorization: Bearer \$DEEPSEEK_API_KEY\" | head -1" >&2
    exit 1
  fi
  printf '%s\n' "$ANSWER"
fi

# ---- slim transcript + meta -------------------------------------------------
TRANSCRIPT="$SESSION_DIR/$SESSION_ID.transcript.md"
{
  echo "### turn @ $(date '+%Y-%m-%d %H:%M:%S')  (model=$MODEL thinking=$THINKING ${elapsed}s)"
  echo
  echo "**Prompt:**"; printf '%s\n\n' "$PROMPT" | sed 's/^/> /'
  echo "**DeepSeek:**"
  if [ "$EMIT_JSON" -eq 1 ]; then echo "(json mode — see raw log)"; else printf '%s\n' "$ANSWER"; fi
  echo; echo "---"; echo
} >> "$TRANSCRIPT"

{
  echo "ds-consult: model=$MODEL thinking=$THINKING elapsed=${elapsed}s session=$SESSION_ID"
  echo "  continue: ds-consult.sh -c \"<follow-up>\"   (or -s $SESSION_ID)"
  echo "  transcript: $TRANSCRIPT"
  [ "$RAW" -eq 1 ] && echo "  raw json:   $TMP_JSON"
} >&2
