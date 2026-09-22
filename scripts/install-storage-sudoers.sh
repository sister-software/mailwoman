#!/usr/bin/env bash
# Install a passwordless-sudo rule for `mwops storage`.
#
# WHY THIS EXISTS
# ---------------
# `mwops storage prepare` writes a partition table, a filesystem and /etc/fstab,
# so it re-execs itself under sudo (packages/storage-kit/lib/sudo.ts). In an
# interactive terminal that prompts once and works fine. This rule exists for the
# non-interactive case — an agent session or a script driving the command — where
# a prompt just hangs.
#
# You do NOT need this to use `mwops storage`. Without it, prepare prompts for
# your password like any other sudo command. Install it only if you want the
# command to run unattended.
#
# SECURITY IMPLICATIONS — READ BEFORE RUNNING
# -------------------------------------------
# This grants the invoking user *unattended root* whenever they invoke the mwops
# CLI under sudo. Concretely:
#
#   1. The rule matches `node <ops-cli>/lib/cli.ts *` — the wildcard is any
#      argument list. It therefore covers every mwops verb, not only storage.
#      Anything that can run as your user can take root without a prompt.
#
#   2. cli.ts becomes a root-trusted entry point, and so does everything it
#      imports. The repo's packages/ tree and its transitive node_modules graph
#      join the root trust boundary.
#
#   3. The pinned node binary becomes root-trusted. Replacing it (an nvm upgrade,
#      a symlink swap) hands passwordless root to the replacement.
#
# Appropriate for a single-user workstation where the user is already
# root-capable and drives host commands from scripts. NOT appropriate for shared
# hosts, servers, or any account less trusted than root.
#
# WHEN TO RE-RUN
#   - After switching Node versions (the rule pins an absolute node path).
#   - After moving the repo.
#
# TO REVOKE
#   sudo rm /etc/sudoers.d/mailwoman-storage

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_PATH="${REPO_ROOT}/packages/ops-cli/lib/cli.ts"
NODE_PATH="$(readlink -f "$(command -v node)")"
TARGET_USER="${SUDO_USER:-$USER}"
SUDOERS_FILE="/etc/sudoers.d/mailwoman-storage"

[[ -f "$CLI_PATH" ]] || { echo "ERROR: mwops CLI not found at $CLI_PATH" >&2; exit 1; }
[[ -x "$NODE_PATH" ]] || { echo "ERROR: could not resolve an executable 'node' on PATH" >&2; exit 1; }

cat <<EOF
Will install a passwordless-sudo rule with:
  user:    ${TARGET_USER}
  node:    ${NODE_PATH}
  script:  ${CLI_PATH}
  file:    ${SUDOERS_FILE}

This covers EVERY mwops verb, not only storage.
Re-read scripts/install-storage-sudoers.sh for the security implications.
EOF

read -rp "Proceed? [y/N] " reply
case "$reply" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 1 ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<EOF
# Managed by scripts/install-storage-sudoers.sh — do not edit by hand.
# Re-run that script after upgrading Node or moving the repo.
${TARGET_USER} ALL=(root) NOPASSWD: ${NODE_PATH} ${CLI_PATH} *
EOF

sudo visudo -cf "$TMP" >/dev/null || { echo "ERROR: generated sudoers file failed validation" >&2; cat "$TMP" >&2; exit 1; }
sudo install -m 0440 -o root -g root "$TMP" "$SUDOERS_FILE"

echo
echo "Installed ${SUDOERS_FILE}."
echo "Test with:  yarn mwops storage verify   (should not prompt)"
