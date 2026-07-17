#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Release-time fail-fast gate: verify the SHIPPED MODEL's metadata has propagated to every human-
 *   facing surface BEFORE a publish goes out. Mirrors the Hugging Face weight-staging preflight in
 *   `.github/workflows/publish.yml` — HEAD-check the surfaces, and on any miss print the exact
 *   remediation and stop, rather than shipping silently and backfilling a release later.
 *
 *   WHY THIS EXISTS (2026-07-17). When 6.4.0 shipped, THREE metadata surfaces were never updated and
 *   nobody noticed until 6.5.0 — all three were hand-backfilled during the 6.5.0 ship:
 *
 *   - `evals/scores-by-version.json` — the per-model score ledger (`mailwoman eval ledger-append`
 *       exists but was manual, so it froze).
 *   - `docs/articles/releases.mdx` — the version matrix, stuck showing an OLD `(current)` row.
 *   - `docs/articles/status.mdx` — the status info box, citing a superseded release.
 *
 *   THE MODEL-vs-npm DISTINCTION (see the "Two version series" intro of releases.mdx). Two version
 *   series exist: the npm version (what `npm install` gives you, bumped in lockstep across all
 *   workspaces on EVERY release) and the trained-model lineage recorded in the weights bundle's
 *   `model-card.json`. A CODE-ONLY release bumps npm but NOT the model card — the model didn't
 *   change, so the ledger/docs shouldn't be forced to grow a new MODEL row. This gate therefore keys
 *   off the MODEL version (the `version` field of `neural-weights-en-us/model-card.json`), not npm /
 *   package.json, and asserts the ledger + docs are current FOR THAT MODEL. A code-only npm bump on
 *   top of an unchanged model still passes, provided every release newer than the model version is
 *   itself a documented "model unchanged" row.
 *
 *   THE THREE CHECKS (keyed off the model-card version V):
 *
 *   1. `evals/scores-by-version.json` has a run whose `model_version === V`.
 *   2. `docs/articles/releases.mdx` has a matrix row for V, AND the `(current)` marker sits on V's
 *      row — OR on a newer row when every release above V is a "model unchanged" (code-only) row.
 *   3. `docs/articles/status.mdx` cites V in its `:::info[Verified as of …]` box.
 *
 *   On any failure: ONE actionable error per surface (the exact command / file+section to fix), then
 *   exit 1. On success: one `OK` line per surface, exit 0.
 *
 *   NOT covered here (tracked follow-up): the isotonic calibration tables in the weights bundle are
 *   still fitted on the v5.3.0 lineage and carried forward — a separate, larger re-fit workstream,
 *   deliberately out of scope for this gate.
 *
 *   Usage:
 *     node scripts/verify-release-metadata.ts
 *     node scripts/verify-release-metadata.ts \
 *       --card neural-weights-en-us/model-card.json \
 *       --ledger evals/scores-by-version.json \
 *       --releases docs/articles/releases.mdx \
 *       --status docs/articles/status.mdx
 *
 *   The path overrides exist so the surfaces can be pointed at doctored copies when exercising the
 *   failure modes; the defaults are the real repo files. Wired into `.github/workflows/publish.yml`
 *   as a step after the HF preflight and before release-it publishes.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs as parseNodeArgs } from "node:util"

import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"

const repoRoot = repoRootPath()

/** Escape a version string for use as a literal inside a RegExp (the dots are the concern). */
function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A word-boundary matcher for an exact version token (so `6.5.0` does not match `6.5.01`). */
function versionMatcher(version: string): RegExp {
	return new RegExp(`(?<![\\w.])${escapeRegExp(version)}(?![\\w.])`)
}

/** One parsed data row of the releases.mdx version matrix, in file order (newest-first). */
interface MatrixRow {
	/** First column (the npm-version cell), with markdown bold stripped. */
	versionCell: string
	/** Third column (the "Model lineage" cell). */
	lineageCell: string
}

interface VerifyOptions {
	cardPath: string
	ledgerPath: string
	releasesPath: string
	statusPath: string
}

interface SurfaceResult {
	surface: string
	ok: boolean
	/** On OK: a one-line summary. On failure: the actionable remediation (may be multi-line). */
	message: string
}

/**
 * Read the shipped MODEL version — the `version` field of the weights bundle's model card. This is the anchor for every
 * check: NOT npm / package.json, so a code-only release (which bumps npm but leaves the card untouched) is judged
 * against the model it actually ships.
 */
function readModelVersion(cardPath: string): string {
	const card = JSON.parse(readFileSync(cardPath, "utf8")) as { version?: string }

	if (!card.version) throw new Error(`model card ${cardPath} has no "version" field`)

	return card.version
}

/** Check 1 — the eval ledger carries a run for this model version. */
function checkLedger(version: string, ledgerPath: string): SurfaceResult {
	const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
		runs?: Array<{ model_version?: string }>
	}
	const runs = ledger.runs ?? []
	const found = runs.some((run) => run.model_version === version)

	if (found) {
		return {
			surface: "eval-ledger",
			ok: true,
			message: `eval ledger has a run for model_version ${version}`,
		}
	}

	return {
		surface: "eval-ledger",
		ok: false,
		message:
			`evals/scores-by-version.json has NO run with model_version === "${version}".\n` +
			`      Append it (the promotion-gate PASS prints this line pre-filled — fill --out-dir/--run-id from that run):\n` +
			`        node mailwoman/out/cli.js eval ledger-append \\\n` +
			`          --out-dir <gate-out-dir> --model-version ${version} \\\n` +
			`          --run-id <label>-<yyyymmdd> \\\n` +
			`          --model-path "@mailwoman/neural-weights-en-us@${version}" --card neural-weights-en-us/model-card.json`,
	}
}

/**
 * Parse the releases.mdx version matrix into ordered data rows. A data row is a `|`-delimited table line whose first
 * cell carries a version-like token; the header and `---` separator rows are skipped. The "## The matrix" table is the
 * only one whose rows look like this, so a global scan is safe.
 */
function parseMatrixRows(markdown: string): MatrixRow[] {
	const rows: MatrixRow[] = []

	for (const line of markdown.split("\n")) {
		const trimmed = line.trim()

		if (!trimmed.startsWith("|")) continue
		// Split into cells, dropping the leading/trailing empties from the outer pipes.
		const cells = trimmed
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim())

		if (cells.length < 3) continue

		const versionCell = cells[0]!.replaceAll("**", "")
		const lineageCell = cells[2]!

		// Skip header ("npm") and separator ("---") rows — they carry no version token.
		if (!/\d/.test(versionCell)) continue

		rows.push({ versionCell, lineageCell })
	}

	return rows
}

/**
 * Check 2 — releases.mdx has a matrix row for V, and the `(current)` marker is on V's row (or on a newer row when every
 * release above V is a documented "model unchanged" code-only bump).
 */
function checkReleases(version: string, releasesPath: string): SurfaceResult {
	const surface = "releases-matrix"
	const markdown = readFileSync(releasesPath, "utf8")
	const rows = parseMatrixRows(markdown)
	const matcher = versionMatcher(version)

	const vIndex = rows.findIndex((row) => matcher.test(row.versionCell))
	const currentIndex = rows.findIndex((row) => row.versionCell.includes("(current)"))

	const rowFix =
		`      Add a matrix row for ${version} under "## The matrix" in docs/articles/releases.mdx\n` +
		`      (newest-first; first column \`**${version}** (current)\`, with date / model lineage / what-it-added / per-tag-truth).`

	if (vIndex === -1) {
		return { surface, ok: false, message: `docs/articles/releases.mdx has NO matrix row for ${version}.\n` + rowFix }
	}

	if (currentIndex === -1) {
		return {
			surface,
			ok: false,
			message:
				`docs/articles/releases.mdx has no "(current)" marker in the matrix.\n` +
				`      Mark ${version}'s first column as \`**${version}** (current)\`.`,
		}
	}

	if (currentIndex === vIndex) {
		return { surface, ok: true, message: `releases.mdx matrix row ${version} carries the "(current)" marker` }
	}

	const { versionCell } = rows[currentIndex]!

	// Rows are newest-first. current ABOVE V (smaller index) is fine ONLY if every row strictly newer
	// than V is a code-only "model unchanged" bump — then V is still the live model and the marker
	// rightly sits on the newest npm row.
	if (currentIndex < vIndex) {
		const newerRows = rows.slice(currentIndex, vIndex)
		const nonCodeOnly = newerRows.filter((row) => !/unchanged/i.test(row.lineageCell))

		if (nonCodeOnly.length === 0) {
			return {
				surface,
				ok: true,
				message: `releases.mdx: model ${version} is current; the marker sits on a newer code-only row (as expected)`,
			}
		}

		return {
			surface,
			ok: false,
			message:
				`docs/articles/releases.mdx marks "${versionCell}" as (current), but a newer row above model ${version} introduces a NEW model:\n` +
				`        ${nonCodeOnly.map((row) => row.versionCell).join(", ")}\n` +
				`      Either the model card was not bumped for that model release, or that row is mislabeled. Reconcile the card version with the matrix.`,
		}
	}

	// current BELOW V (larger index) — the marker is stuck on an OLDER release than the shipped model.
	return {
		surface,
		ok: false,
		message:
			`docs/articles/releases.mdx marks "${versionCell}" as (current), but the shipped model is ${version}.\n` +
			`      Move the "(current)" marker to ${version}'s row (first column \`**${version}** (current)\`) and drop it from the stale row.`,
	}
}

/** Check 3 — the status.mdx info box cites this model version. */
function checkStatus(version: string, statusPath: string): SurfaceResult {
	const surface = "status-infobox"
	const markdown = readFileSync(statusPath, "utf8")

	const start = markdown.indexOf(":::info[")

	if (start === -1) {
		return {
			surface,
			ok: false,
			message:
				`docs/articles/status.mdx has no ":::info[Verified as of …]" box.\n` +
				`      Add / restore the info box and cite release ${version}.`,
		}
	}
	const end = markdown.indexOf(":::", start + 1)
	const infoBox = markdown.slice(start, end === -1 ? undefined : end)

	if (versionMatcher(version).test(infoBox)) {
		return { surface, ok: true, message: `status.mdx info box cites ${version}` }
	}

	return {
		surface,
		ok: false,
		message:
			`docs/articles/status.mdx ":::info[Verified as of …]" box does NOT cite the shipped model ${version}.\n` +
			`      Update the ":::info[Verified as of <date> — release ${version}]" header (and the body model paragraph) to ${version}.`,
	}
}

async function main() {
	const { values } = parseNodeArgs({
		options: {
			card: { type: "string" },
			ledger: { type: "string" },
			releases: { type: "string" },
			status: { type: "string" },
		},
	})

	const options: VerifyOptions = {
		cardPath: resolve(repoRoot, values.card ?? "neural-weights-en-us/model-card.json"),
		ledgerPath: resolve(repoRoot, values.ledger ?? "evals/scores-by-version.json"),
		releasesPath: resolve(repoRoot, values.releases ?? "docs/articles/releases.mdx"),
		statusPath: resolve(repoRoot, values.status ?? "docs/articles/status.mdx"),
	}

	const version = readModelVersion(options.cardPath)
	console.log(`verify-release-metadata: shipped MODEL version (from model card) = ${version}\n`)

	const results: SurfaceResult[] = [
		checkLedger(version, options.ledgerPath),
		checkReleases(version, options.releasesPath),
		checkStatus(version, options.statusPath),
	]

	for (const result of results) {
		if (result.ok) {
			console.log(`  ✓ ${result.surface}: ${result.message}`)
		} else {
			console.error(`  ✗ ${result.surface}: ${result.message}`)
		}
	}

	const failures = results.filter((result) => !result.ok)

	if (failures.length > 0) {
		console.error(
			`\nverify-release-metadata FAILED: ${failures.length} surface(s) stale for model ${version}. ` +
				`Fix the item(s) above (each surface is independent), commit, then re-dispatch the publish.`
		)
		process.exitCode = 1

		return
	}

	console.log(`\nverify-release-metadata OK: model ${version} is fully propagated to the ledger + docs.`)
}

runIfScript(import.meta, main)
