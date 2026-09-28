#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Release-time fail-fast check: verify the shipped model's metadata has propagated to every
 *   human-facing surface before a publish goes out.
 *
 *   Keyed off the model version — the `version` field of the weights bundle's model card — rather
 *   than npm package.json, so a code-only npm bump on top of an unchanged model still passes.
 *
 *   Usage:
 *     yarn mwops release verify-metadata
 *     yarn mwops release verify-metadata \
 *       --card packages/neural-weights-en-us/model-card.json \
 *       --ledger evals/scores-by-version.json \
 *       --releases docs/engineering/releases.mdx \
 *       --status docs/articles/developers/status.mdx
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { type PathBuilderLike, resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

/**
 * Cells a markdown table row needs before it carries a version/date/status triple.
 */
const MIN_TABLE_CELLS = 3

/**
 * A word-boundary matcher for an exact version token (so `6.5.0` does not match `6.5.01`).
 */
function versionMatcher(version: string): RegExp {
	return new RegExp(`(?<![\\w.])${escapeRegExp(version)}(?![\\w.])`)
}

/**
 * One parsed data row of the releases.mdx version matrix, in file order (newest-first).
 */
interface MatrixRow {
	/**
	 * First column (the npm-version cell), with markdown bold stripped.
	 */
	versionCell: string
	/**
	 * Third column (the "Model lineage" cell).
	 */
	lineageCell: string
}

export interface VerifyReleaseMetadataOptions {
	repoRoot: PathBuilderLike
	/**
	 * Repo-relative (or absolute) overrides for each surface.
	 * The defaults are the real repo files.
	 */
	card?: string
	ledger?: string
	releases?: string
	status?: string
	log: (line: string) => void
}

/**
 * The directory `docs/docusaurus.config.ts` publishes (`path: "articles"`); a status page outside
 * it is not a page a reader opens, so citing the shipped model there establishes no published fact.
 */
const PUBLISHED_DOCS_ROOT = "docs/articles/"

/**
 * The page https://mailwoman.ai serves as "What ships today".
 */
const PUBLISHED_STATUS_PAGE = `${PUBLISHED_DOCS_ROOT}developers/status.mdx`

/**
 * Refuse a status path outside the published tree, so a check cannot report success by resolving a
 * page the site does not publish.
 */
function assertPublishedStatusPage(statusPath: string): void {
	if (statusPath.startsWith(PUBLISHED_DOCS_ROOT)) return

	throw new Error(
		`verify-release-metadata: the status surface must be a page the site publishes, under ${PUBLISHED_DOCS_ROOT} ` +
			`(received ${statusPath}). Only that tree is built — a page elsewhere can cite the shipped model while ` +
			`the page a reader opens does not.`
	)
}

export interface SurfaceResult {
	surface: string
	ok: boolean
	/**
	 * On OK a one-line summary; on failure the actionable remediation, which may be multi-line.
	 */
	message: string
}

/**
 * Read the shipped model version — the `version` field of the weights bundle's model card, not npm
 * package.json, so a code-only release is judged against the model it actually ships.
 */
async function readModelVersion(cardPath: string): Promise<string> {
	const card = await readLocalJSONFile<{ version?: string }>(cardPath)

	if (!card.version) throw new Error(`model card ${cardPath} has no "version" field`)

	return card.version
}

async function checkLedger(version: string, ledgerPath: string): Promise<SurfaceResult> {
	const ledger = await readLocalJSONFile<{
		runs?: Array<{ model_version?: string }>
	}>(ledgerPath)

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
			`      Append it (the promotion-eval PASS prints this line pre-filled — fill --out-dir/--run-id from that run):\n` +
			`        node packages/mailwoman/out/cli/index.js eval ledger-append \\\n` +
			`          --out-dir <eval-out-dir> --model-version ${version} \\\n` +
			`          --run-id <label>-<yyyymmdd> \\\n` +
			`          --model-path "@mailwoman/neural-weights-en-us@${version}" --card packages/neural-weights-en-us/model-card.json`,
	}
}

/**
 * Parse the releases.mdx version matrix into ordered data rows; a global scan is safe because only
 * the "## The matrix" table has version-like first cells.
 */
function parseMatrixRows(markdown: string): MatrixRow[] {
	const rows: MatrixRow[] = []

	for (const line of TextSpliterator.from(markdown)) {
		if (!line.startsWith("|")) continue

		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim())

		if (cells.length < MIN_TABLE_CELLS) continue

		const versionCell = cells[0]!.replaceAll("**", "")
		const lineageCell = cells[2]!

		if (!/\d/.test(versionCell)) continue

		rows.push({ versionCell, lineageCell })
	}

	return rows
}

/**
 * The version on the matrix row carrying the `(current)` marker, or null when no row does.
 */
export function currentMatrixVersion(markdown: string): string | null {
	const row = parseMatrixRows(markdown).find((candidate) => candidate.versionCell.includes("(current)"))

	return row?.versionCell.match(/\d[\d.]*/)?.[0] ?? null
}

async function checkReleases(version: string, releasesPath: string): Promise<SurfaceResult> {
	const surface = "releases-matrix"
	const markdown = await readLocalTextFile(releasesPath)
	const rows = parseMatrixRows(markdown)
	const matcher = versionMatcher(version)

	const vIndex = rows.findIndex((row) => matcher.test(row.versionCell))
	const currentIndex = rows.findIndex((row) => row.versionCell.includes("(current)"))

	const rowFix =
		`      Add a matrix row for ${version} under "## The matrix" in docs/engineering/releases.mdx\n` +
		`      (newest-first; first column \`**${version}** (current)\`, with date / model lineage / what-it-added / per-tag-truth).`

	if (vIndex === -1) {
		return {
			surface,
			ok: false,
			message: `docs/engineering/releases.mdx has NO matrix row for ${version}.\n` + rowFix,
		}
	}

	if (currentIndex === -1) {
		return {
			surface,
			ok: false,
			message:
				`docs/engineering/releases.mdx has no "(current)" marker in the matrix.\n` +
				`      Mark ${version}'s first column as \`**${version}** (current)\`.`,
		}
	}

	if (currentIndex === vIndex) {
		return { surface, ok: true, message: `releases.mdx matrix row ${version} carries the "(current)" marker` }
	}

	const { versionCell } = rows[currentIndex]!

	// Current above V is fine only if every row strictly newer than V is a code-only "model
	// unchanged" bump — then V is still the live model and the marker rightly sits on the newest row.
	if (currentIndex < vIndex) {
		const newerRows = rows.slice(currentIndex, vIndex)
		const nonCodeOnly = newerRows.filter((row) => !/unchanged/i.test(row.lineageCell))

		if (!nonCodeOnly.length) {
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
				`docs/engineering/releases.mdx marks "${versionCell}" as (current), but a newer row above model ${version} introduces a NEW model:\n` +
				`        ${nonCodeOnly.map((row) => row.versionCell).join(", ")}\n` +
				`      Either the model card was not bumped for that model release, or that row is mislabeled. Reconcile the card version with the matrix.`,
		}
	}

	return {
		surface,
		ok: false,
		message:
			`docs/engineering/releases.mdx marks "${versionCell}" as (current), but the shipped model is ${version}.\n` +
			`      Move the "(current)" marker to ${version}'s row (first column \`**${version}** (current)\`) and drop it from the stale row.`,
	}
}

async function checkStatus(version: string, statusPath: string): Promise<SurfaceResult> {
	const surface = "status-infobox"
	const markdown = await readLocalTextFile(statusPath)

	const start = markdown.indexOf(":::info[")

	if (start === -1) {
		return {
			surface,
			ok: false,
			message:
				`docs/articles/developers/status.mdx has no ":::info[Verified as of …]" box.\n` +
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
			`docs/articles/developers/status.mdx ":::info[Verified as of …]" box does NOT cite the shipped model ${version}.\n` +
			`      Update the ":::info[Verified as of <date> — release ${version}]" header (and the body model paragraph) to ${version}.`,
	}
}

export interface VerifyReleaseMetadataReport {
	modelVersion: string
	surfaces: SurfaceResult[]
}

/**
 * Check every surface for the shipped model version.
 *
 * @throws When any surface is stale, with each remediation already reported through `log`,
 * so a caller's exit code follows the verdict.
 */
export async function verifyReleaseMetadata(
	options: VerifyReleaseMetadataOptions
): Promise<VerifyReleaseMetadataReport> {
	const { repoRoot, log } = options

	const statusRelative = options.status ?? PUBLISHED_STATUS_PAGE

	assertPublishedStatusPage(statusRelative)

	const paths = {
		cardPath: resolvePath(repoRoot, options.card ?? "packages/neural-weights-en-us/model-card.json"),
		ledgerPath: resolvePath(repoRoot, options.ledger ?? "evals/scores-by-version.json"),
		releasesPath: resolvePath(repoRoot, options.releases ?? "docs/engineering/releases.mdx"),
		statusPath: resolvePath(repoRoot, statusRelative),
	}

	const version = await readModelVersion(paths.cardPath)

	log(`verify-release-metadata: shipped MODEL version (from model card) = ${version}\n`)

	const results: SurfaceResult[] = [
		await checkLedger(version, paths.ledgerPath),
		await checkReleases(version, paths.releasesPath),
		await checkStatus(version, paths.statusPath),
	]

	for (const result of results) {
		log(`  ${result.ok ? "✓" : "✗"} ${result.surface}: ${result.message}`)
	}

	const failures = results.filter((result) => !result.ok)

	if (failures.length) {
		throw new Error(
			`verify-release-metadata FAILED: ${failures.length} of ${results.length} surfaces stale for model ${version}. ` +
				`Fix the item(s) above (each surface is independent), commit, then re-dispatch the publish.`
		)
	}

	log(`\nverify-release-metadata OK: model ${version} is fully propagated to the ledger + docs.`)

	return { modelVersion: version, surfaces: results }
}
