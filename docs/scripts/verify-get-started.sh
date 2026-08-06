#!/usr/bin/env bash
#
# Cold-trial harness for the get-started trio (docs-reorg Task 9):
#   docs/articles/developers/get-started/install-and-first-parse.mdx
#   docs/articles/developers/get-started/ten-minute-trial.mdx
#
# Proves the pages' pasted transcripts are still true against a REAL consumer install, not the
# monorepo's own hoisted node_modules — the same trap `feedback-core-standalone-install-zx` (project
# memory) and `scripts/smoke-clean-install.ts` exist for: a workspace-linked dev tree resolves things
# (a sibling package, a locale overlay) that a stranger's `npm install` never would.
#
# Method: pack the closure `mailwoman` + `@mailwoman/neural` + `@mailwoman/neural-weights-en-us` pull
# in (every workspace:* dependency, computed by walking package.json — NOT a hand-maintained list, so
# it can't drift the way a copied array would), `npm install` the tarballs into a project OUTSIDE the
# repo tree (no hoisting possible), then run the pages' commands verbatim and assert their claims.
#
# Two tiers, split on whether the step needs network beyond npm's own registry fetch:
#   - Always on: `yarn compile`, pack, install, `mailwoman parse` (the install-and-first-parse.mdx
#     script) and `mailwoman doctor` + the shell `parse` example (ten-minute-trial.mdx steps 1-4).
#     Doctor makes no network call of its own; parsing needs none either. This is the "parse-only"
#     leg Task 7's dropin-cold-start.test.ts convention names — the half of the page that ships
#     unconditionally.
#   - Gated behind MAILWOMAN_COLD_START_FULL=1: a REAL `mailwoman data pull candidate` (~1.65 GB) and
#     the two `mailwoman geocode` calls (US + FR) ten-minute-trial.mdx's step 5 shows. Off by default
#     so a routine run (and CI) downloads nothing. Set MAILWOMAN_COLD_START_DATA_ROOT to a persistent
#     directory to skip re-downloading candidate.db on a repeat run; left unset, a fresh throwaway
#     root is used and removed after.
#
# Usage:
#   docs/scripts/verify-get-started.sh                              # always-on leg only
#   MAILWOMAN_COLD_START_FULL=1 docs/scripts/verify-get-started.sh   # + the real geocode leg
#
# Re-run by Task 23 (docs-reorg) as the trio's standing regression check.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

log() { echo "[verify-get-started] $*" >&2; }
fail() {
	echo "FAIL: $*" >&2
	exit 1
}

log "compiling ($REPO_ROOT)…"
(cd "$REPO_ROOT" && yarn compile)

TAR_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mw-verify-getstarted-tars.XXXXXX")"
PROJ_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mw-verify-getstarted-proj.XXXXXX")"
DOCTOR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mw-verify-getstarted-doctor.XXXXXX")"
rmdir "$DOCTOR_ROOT" # doctor's own "data root does not exist" branch needs the dir absent, not empty

cleanup() {
	rm -rf "$TAR_DIR" "$PROJ_DIR" "$DOCTOR_ROOT"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------------
# Pack the mailwoman + neural + neural-weights-en-us closure — the exact `npm install` line
# install-and-first-parse.mdx's Step 1 prints — into $TAR_DIR, deriving the full workspace:* closure
# live (mirrors scripts/smoke-clean-install.ts's WORKSPACES map, computed instead of hand-typed) and
# reusing the SAME publish-shaped pack (scripts/pack-workspace.ts's packWorkspaceForPublish) release
# actually ships, so a dev-only `exports` map never sneaks past this check.
# ---------------------------------------------------------------------------------------------------
PACK_HELPER="$TAR_DIR/pack-closure.mjs"

cat >"$PACK_HELPER" <<'NODE_EOF'
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const [, , repoRoot, tarDir] = process.argv
const seeds = ["mailwoman", "@mailwoman/neural", "@mailwoman/neural-weights-en-us"]

const { packWorkspaceForPublish } = await import(resolve(repoRoot, "scripts/pack-workspace.ts"))

const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"))
const nameToDir = {}

for (const dir of rootPkg.workspaces) {
	try {
		const pkg = JSON.parse(readFileSync(resolve(repoRoot, dir, "package.json"), "utf8"))
		nameToDir[pkg.name] = dir
	} catch {
		// A workspace entry with no package.json yet (shouldn't happen here) — skip rather than crash.
	}
}

// BFS over workspace:* dependencies/optionalDependencies/peerDependencies, starting from the three
// packages the get-started page actually tells a reader to install. Computed, not copied — a package
// added to mailwoman's dependency graph is picked up automatically, so this can't go stale the way a
// hand-maintained array would.
const closure = new Set()
const queue = [...seeds]

while (queue.length) {
	const name = queue.pop()
	if (closure.has(name)) continue
	closure.add(name)

	const dir = nameToDir[name]
	if (!dir) throw new Error(`no workspace directory found for ${name} (checked root package.json workspaces)`)

	const pkg = JSON.parse(readFileSync(resolve(repoRoot, dir, "package.json"), "utf8"))

	for (const depType of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [dep, spec] of Object.entries(pkg[depType] ?? {})) {
			if (typeof spec === "string" && spec.startsWith("workspace:") && !closure.has(dep)) {
				queue.push(dep)
			}
		}
	}
}

const deps = {}

for (const name of [...closure].sort()) {
	const dir = nameToDir[name]
	const tgz = resolve(tarDir, `${dir}.tgz`)

	console.error(`[pack-closure] ${name} (${dir}) -> ${tgz}`)
	packWorkspaceForPublish(resolve(repoRoot, dir), tgz)
	deps[name] = `file:${tgz}`
}

writeFileSync(resolve(tarDir, "closure-deps.json"), JSON.stringify(deps, null, 2))
console.error(`[pack-closure] packed ${closure.size} workspaces`)
NODE_EOF

log "packing the mailwoman + neural + neural-weights-en-us closure…"
node "$PACK_HELPER" "$REPO_ROOT" "$TAR_DIR"

# ---------------------------------------------------------------------------------------------------
# Install the tarballs into a project OUTSIDE the repo — nothing here can resolve via the monorepo's
# own hoisted node_modules, which is the entire point of the probe.
# ---------------------------------------------------------------------------------------------------
node -e '
const fs = require("node:fs")
const path = require("node:path")
const tarDir = process.argv[1]
const projDir = process.argv[2]
const deps = JSON.parse(fs.readFileSync(path.join(tarDir, "closure-deps.json"), "utf8"))
fs.writeFileSync(
	path.join(projDir, "package.json"),
	JSON.stringify({ name: "mw-verify-getstarted", private: true, type: "module", dependencies: deps }, null, 2)
)
' "$TAR_DIR" "$PROJ_DIR"

log "npm install (tarballs only — no hoisting)…"
if ! install_out=$(cd "$PROJ_DIR" && npm install --no-audit --no-fund --no-package-lock 2>&1); then
	echo "$install_out" >&2
	fail "npm install failed"
fi

CLI="$PROJ_DIR/node_modules/mailwoman/out/cli.js"

# ---------------------------------------------------------------------------------------------------
# Always-on leg: install-and-first-parse.mdx's script, verbatim, plus ten-minute-trial.mdx's steps
# 1-4 (doctor + the shell parse example). No network beyond what `npm install` already did above.
# ---------------------------------------------------------------------------------------------------
log "install-and-first-parse.mdx: the parse.mjs script…"

cat >"$PROJ_DIR/parse.mjs" <<'JS_EOF'
import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const result = await parse("apt 4b 350 5th ave new york ny 10118")

console.log("input:", result.input)
console.log("locale:", result.locale.locale)
console.log("kind:", result.kind.kind)
console.log()

function print(node, depth = 0) {
	const pad = "  ".repeat(depth)
	console.log(`${pad}${node.tag}: "${node.value}"  (confidence ${node.confidence.toFixed(2)})`)
	for (const child of node.children) print(child, depth + 1)
}

for (const root of result.tree.roots) print(root)
JS_EOF

if ! parse_out=$(cd "$PROJ_DIR" && node parse.mjs 2>&1); then
	echo "$parse_out" >&2
	fail "parse.mjs (install-and-first-parse.mdx) crashed"
fi

for needle in 'locale: en-US' 'kind: structured_address' 'locality: "New York"' 'postcode: "10118"' 'house_number: "350"'; do
	if [[ "$parse_out" != *"$needle"* ]]; then
		echo "$parse_out" >&2
		fail "parse.mjs output missing expected '$needle' — install-and-first-parse.mdx no longer matches"
	fi
done
log "  ok — parse.mjs output matches the page"

log "ten-minute-trial.mdx step 2: mailwoman doctor (cold, no data root)…"
doctor_out="$(MAILWOMAN_DATA_ROOT="$DOCTOR_ROOT" node "$CLI" doctor 2>&1)" || true

for needle in 'Model weights (en-us)' 'Node runtime' 'ONNX runtime' 'mailwoman data pull candidate' 'mailwoman data pull poi' 'not installed' 'PASS'; do
	if [[ "$doctor_out" != *"$needle"* ]]; then
		echo "$doctor_out" >&2
		fail "doctor output missing expected '$needle' — ten-minute-trial.mdx's doctor transcript no longer matches"
	fi
done

# The gazetteer fix line is ONE command now. Through 8.6.0 it read
# `mailwoman data pull candidate   (then: export MAILWOMAN_CANDIDATE_DB=…)`, because writing the file
# did not wire it up; the convention-path fallback removed that second half. The positive check above
# passes either way — it is a substring — so assert the absence too, or the page's transcript can drift
# back without failing anything.
if [[ "$doctor_out" == *"export MAILWOMAN_CANDIDATE_DB"* ]]; then
	echo "$doctor_out" >&2
	fail "doctor still prints an export line — ten-minute-trial.mdx teaches the bare pull as the whole fix"
fi
log "  ok — doctor output matches the page"

log "ten-minute-trial.mdx step 3: mailwoman parse (shell)…"
if ! shell_parse_out=$(node "$CLI" parse "350 5th Ave, New York, NY 10118" 2>&1); then
	echo "$shell_parse_out" >&2
	fail "mailwoman parse (shell) crashed"
fi

for needle in '"locality": "New York"' '"postcode": "10118"' '"house_number": "350"'; do
	if [[ "$shell_parse_out" != *"$needle"* ]]; then
		echo "$shell_parse_out" >&2
		fail "mailwoman parse (shell) output missing expected '$needle'"
	fi
done
log "  ok — shell parse output matches the page"

if [[ "${MAILWOMAN_COLD_START_FULL:-}" != "1" ]]; then
	log "MAILWOMAN_COLD_START_FULL not set — skipping the real candidate.db pull + geocode leg."
	log "all checks passed (always-on leg only)"
	exit 0
fi

# ---------------------------------------------------------------------------------------------------
# Gated leg: ten-minute-trial.mdx step 5 — a REAL `data pull candidate` (~1.65 GB) then the US + FR
# geocode calls. Reuses MAILWOMAN_COLD_START_DATA_ROOT if the caller points at one (so a repeat run
# doesn't re-download), else a fresh throwaway root that's removed after.
# ---------------------------------------------------------------------------------------------------
OWN_DATA_ROOT=0
if [[ -n "${MAILWOMAN_COLD_START_DATA_ROOT:-}" ]]; then
	DATA_ROOT="$MAILWOMAN_COLD_START_DATA_ROOT"
	mkdir -p "$DATA_ROOT"
else
	DATA_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mw-verify-getstarted-data.XXXXXX")"
	OWN_DATA_ROOT=1
fi

cleanup_data_root() {
	if [[ "$OWN_DATA_ROOT" == "1" ]]; then
		rm -rf "$DATA_ROOT"
	fi
}
trap 'cleanup_data_root; cleanup' EXIT

CANDIDATE_DB="$DATA_ROOT/wof/candidate.db"

if [[ -f "$CANDIDATE_DB" ]]; then
	log "candidate.db already present at $CANDIDATE_DB — skipping the download"
else
	log "mailwoman data pull candidate (~1.65 GB — this is the heavy leg)…"
	if ! pull_out=$(MAILWOMAN_DATA_ROOT="$DATA_ROOT" node "$CLI" data pull candidate 2>&1); then
		echo "$pull_out" >&2
		fail "mailwoman data pull candidate failed"
	fi
	if [[ "$pull_out" != *"PASS"* ]] || [[ ! -f "$CANDIDATE_DB" ]]; then
		echo "$pull_out" >&2
		fail "data pull candidate did not land $CANDIDATE_DB"
	fi
fi

# NO $MAILWOMAN_CANDIDATE_DB below, deliberately. The page stopped telling readers to export it when
# the candidate backend became the default (mailwoman 8.7.0), so these two calls assert the thing the
# page now promises: that `<data root>/wof/candidate.db` is found with nothing configured. Exporting
# the variable here would pass whether or not that fallback works.
log "ten-minute-trial.mdx step 5: mailwoman geocode (US address, convention-path discovery)…"
if ! us_out=$(MAILWOMAN_DATA_ROOT="$DATA_ROOT" node "$CLI" geocode "350 5th Ave, New York, NY 10118" 2>&1); then
	echo "$us_out" >&2
	fail "mailwoman geocode (US) failed"
fi

for needle in '"locality": "New York"' '"region": "NY"' '"countryCode": "US"'; do
	if [[ "$us_out" != *"$needle"* ]]; then
		echo "$us_out" >&2
		fail "US geocode output missing expected '$needle'"
	fi
done
log "  ok — US geocode resolves in the US"

log "ten-minute-trial.mdx step 5: mailwoman geocode (FR address — the ledgered routing case)…"
if ! fr_out=$(MAILWOMAN_DATA_ROOT="$DATA_ROOT" node "$CLI" geocode "12 Rue de Rivoli, 75001 Paris" 2>&1); then
	echo "$fr_out" >&2
	fail "mailwoman geocode (FR) failed"
fi

if [[ "$fr_out" != *'"countryCode": "FR"'* ]]; then
	echo "$fr_out" >&2
	fail "FR geocode did not route to FR — the candidate backend regressed to the FTS Paris-Texas misroute"
fi
log "  ok — FR geocode routes to France, not Texas"

log "all checks passed (full leg, candidate.db pulled + both geocodes verified)"
