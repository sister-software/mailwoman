/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared resolver-backend selector for the CLI commands + server routers. Picks the byte-range
 *   CANDIDATE-table lookup ({@link WOFCandidateTableLookup}) — the SAME backend + population-first,
 *   country-agnostic ranking the browser demo uses — when a `candidate.db` is reachable, else the
 *   FTS admin lookup ({@link WOFSQLitePlaceLookup}).
 *
 *   Why this exists: the demo resolves localities population-first ("Moscow" → the 10.4 M-pop Russian
 *   city), but the FTS resolver ranks by bm25 + exact-match tiering, so a bare homonym goes to
 *   whichever same-name place bm25 floats up (often a small US township). The candidate table also
 *   carries 3.66 M postcodes and the exonym aliases that map `Munich` onto `München`, neither of
 *   which the FTS admin database stocks.
 *
 *   The candidate table is the DEFAULT: {@link resolveCandidateDBPath} falls back to the convention
 *   path, so a pulled gazetteer is picked up with nothing exported. `MAILWOMAN_CANDIDATE_DB=none`
 *   (or `--candidate-db none`) pins the FTS backend.
 */

import { mailwomanDataRoot } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/core/env"
import { pathExists, readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPathBuilder } from "@mailwoman/core/paths"
import { wofExtractPaths } from "@mailwoman/core/utils"
import type {
	PlaceLookup,
	WOFCandidateTableLookup,
	WOFPostalCityAliasLookup,
	WOFSQLitePlaceLookup,
} from "@mailwoman/resolver-wof-sqlite"
import { readCapitalPoints } from "@mailwoman/resolver-wof-sqlite/capital-schema"
import { CapitalIndex, type CapitalPoint } from "@mailwoman/resolver-wof-sqlite/capitals"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join, resolvePath, type PathBuilderLike } from "path-ts"

/**
 * The candidate gazetteer's conventional home — where `mailwoman data pull candidate` writes it, and where every caller
 * looks when nothing points somewhere else.
 */
export function conventionCandidateDBPath(dataRoot: PathBuilderLike = mailwomanDataRoot()): string {
	return resolvePath(dataRoot, "wof", "candidate.db")
}

/**
 * Resolve the candidate-db path: an explicit option, then `$MAILWOMAN_CANDIDATE_DB`, then the convention path. Each is
 * used only if it exists on disk. `none` at either the explicit or the env position pins the FTS backend instead.
 *
 * The convention fallback is what makes the candidate table the DEFAULT backend. See
 * docs/engineering/reference/resolver-backends.mdx for the tier-1 measurement behind that default, the named residuals,
 * and the 2×2 any comparison between the two backends has to run.
 */
export async function resolveCandidateDBPath(
	explicit?: string,
	dataRoot: PathBuilderLike = mailwomanDataRoot()
): Promise<string | undefined> {
	const pinned = explicit ?? $public.MAILWOMAN_CANDIDATE_DB

	if (pinned === "none") return undefined

	if (pinned) return (await pathExists(pinned)) ? pinned : undefined

	const convention = conventionCandidateDBPath(dataRoot)

	return (await pathExists(convention)) ? convention : undefined
}

/**
 * The WOF admin database set a caller should probe: an explicit comma-separated list, then `$MAILWOMAN_WOF_DB` (the
 * HealthRouter multi-database convention), else {@link wofExtractPaths}'s default set.
 *
 * Returned UNFILTERED — whether a missing path is a degradation or an error is the caller's contract, not this
 * function's. `createGeocodeSession` filters with `pathExists` and throws when nothing survives; `mailwoman doctor`
 * reports each absence; a probe wants to say which database it could not open. Sharing the SELECTION is the point: a
 * caller that reads only `wofExtractPaths` silently probes different databases than the runtime on any box where the
 * env is set, which is the exact class of wrong answer a data-source probe exists to rule out.
 */
export function resolveWOFDatabasePaths(explicit?: string, dataRoot: PathBuilderLike = mailwomanDataRoot()): string[] {
	const raw = explicit ?? $public.MAILWOMAN_WOF_DB

	if (raw) {
		return raw
			.split(",")
			.map((path) => path.trim())
			.filter((path) => path.length > 0)
	}

	return [...wofExtractPaths(dataRoot)]
}

/**
 * Resolve the postal-city-alias-db path from an explicit option then `$MAILWOMAN_POSTAL_CITY_ALIAS_DB` (#475);
 * undefined if unset or missing. Only consulted on the FTS backend (the candidate backend folds aliases at build time,
 * not at query time).
 */
export async function resolvePostalCityAliasDBPath(explicit?: string): Promise<string | undefined> {
	const p = explicit ?? $public.MAILWOMAN_POSTAL_CITY_ALIAS_DB

	return p && (await pathExists(p)) ? p : undefined
}

export { dataRootPath, mailwomanDataRoot, wofExtractPaths } from "@mailwoman/core/utils"

/**
 * The #1009 "no gazetteer data found" preflight message, shared by every caller that checks on a candidate/WOF resolver
 * being present before it will boot (`photon/cli.ts`, `nominatim/cli.ts`, `mailwoman/api-engine.ts`'s `mailwoman
 * serve`). Originally a bare `curl -fSL https://public.mailwoman.ai/...` line; measured 2026-08-03
 * (`commands/data/pull.tsx`'s `downloadToDisk` docstring) that an UNRANGED GET against that bucket 403s — the hint was
 * broken for every stranger who copy-pasted it. `mailwoman data pull candidate` (Task 6) is the fix: it carries the
 * `Range: bytes=0-` header the WAF requires, verifies the download, and atomically seals it into place.
 *
 * A bare `data pull candidate` is the whole fix everywhere: {@link resolveCandidateDBPath} reaches the convention path
 * this message names, so no export follows the download.
 */
export function buildNoGazetteerMessage(opts: { dataRoot: string; docsPath: string }): string {
	const conventionCandidate = join(opts.dataRoot, "wof", "candidate.db")

	const afterPull = [`  The file lands at ${conventionCandidate} and is auto-detected there — just re-run.`]

	return [
		"✗ no gazetteer data found — the endpoint needs a resolver database to answer queries.",
		"",
		"  Fastest path (worldwide resolution, population-first ranking, ~1.65 GB):",
		"    mailwoman data pull candidate",
		"",
		...afterPull,
		"",
		"  Or point at your own:",
		"    --candidate-db <path> / $MAILWOMAN_CANDIDATE_DB   (candidate gazetteer)",
		"    $MAILWOMAN_WOF_DB / <data-root>/wof/*.db          (admin WOF distribution)",
		"",
		`  Docs: https://mailwoman.ai${opts.docsPath}`,
	].join("\n")
}

/**
 * The lookup constructors this selector needs — a structural subset of `@mailwoman/resolver-wof-sqlite`.
 */
interface ResolverLookupModule {
	WOFSQLitePlaceLookup: typeof WOFSQLitePlaceLookup
	WOFCandidateTableLookup: typeof WOFCandidateTableLookup
	WOFPostalCityAliasLookup: typeof WOFPostalCityAliasLookup
}

/**
 * Build the resolver backend. `candidateDB` (explicit or env) → candidate-table lookup (demo-parity); otherwise the FTS
 * lookup over `wofPaths` (single path or admin+postcode database list). On the FTS path, a configured postal-city-alias
 * db (#475) is attached so a postal city resolves to its geographic locality — opt-in, default-off (unset env →
 * byte-identical FTS path).
 */
export async function createResolverBackend(
	mod: ResolverLookupModule,
	opts: {
		candidateDB?: string
		dataRoot?: PathBuilderLike
		wofPaths: string | string[]
		postalCityAliasDB?: string
		/**
		 * #1882 — exempt own-name `variant` aliases from the cross-country primary-preference penalty. Candidate backend
		 * only (the penalty lives there). Default ON; pass `false` to disable. On an artifact without the `name_role`
		 * column the exemption matches no row and resolution is byte-identical, so the default is old-artifact-safe.
		 */
		variantAliasExemption?: boolean
	}
): Promise<PlaceLookup> {
	const candidate = await resolveCandidateDBPath(opts.candidateDB, opts.dataRoot)

	if (candidate) {
		console.error(`[resolver] candidate-table backend (demo-parity, population-first): ${candidate}`)

		return new mod.WOFCandidateTableLookup({
			databasePath: candidate,
			...(opts.variantAliasExemption !== false ? { variantAliasExemption: true } : {}),
		})
	}

	const wp = opts.wofPaths
	const aliasDB = await resolvePostalCityAliasDBPath(opts.postalCityAliasDB)
	const postalCityAliases = aliasDB ? new mod.WOFPostalCityAliasLookup({ databasePath: aliasDB }) : undefined

	if (postalCityAliases) {
		console.error(`[resolver] postal-city alias scorer enabled (#475): ${aliasDB}`)
	}

	return new mod.WOFSQLitePlaceLookup({
		databasePath: Array.isArray(wp) && wp.length === 1 ? wp[0]! : wp,
		postalCityAliases,
	})
}

/**
 * Where the committed capital-status reference lives (`mailwoman gazetteer capitals` writes it). Repo-relative because
 * the file ships with the SOURCE tree, not the data root: it is small, committed, and versioned with the ranking code
 * that interprets it. Baking it into `candidate.db` at the next gazetteer rebuild is the follow-up recorded on #1880.
 */
export function conventionCapitalsPath(): string {
	return String(repoRootPathBuilder("data", "gazetteer", "capitals-v1.json"))
}

/**
 * Load the capital-status reference into the ranking index, preferring the ARTIFACT copy: a `candidate.db` that carries
 * the `capital` table (#1880's distribution home) serves npm consumers who never have the repo file; the repo's
 * `data/gazetteer/capitals-v1.json` is the dev fallback.
 *
 * When NEITHER source exists, `missing` decides. `"throw"` (the default) is for an EXPLICIT `capital_tier: true` — a
 * config key the caller asked for that silently no-ops grades as "inert" when it never ran. `"degrade"` returns
 * `undefined` with one stderr line and is for the default-ON path: a consumer running an older artifact keeps working
 * with no capital promotion rather than failing at session construction (positive evidence only). A reference that
 * EXISTS but is malformed throws under both modes — a corrupt file is a defect, never an absence.
 */
export async function loadCapitalIndex(opts: {
	candidateDB?: string
	path?: string
	missing?: "throw" | "degrade"
}): Promise<CapitalIndex | undefined> {
	if (opts.candidateDB && (await pathExists(opts.candidateDB))) {
		using db = new DatabaseClient<WOFDatabase>(opts.candidateDB, { readOnly: true })

		const points = readCapitalPoints(db)

		// `null` = the artifact predates the table (fall through to the repo file); an EMPTY table is a
		// built fact and is served as such.
		if (points) {
			console.error(`[resolver] capital reference: ${points.length} rows from the candidate artifact`)

			return new CapitalIndex(points)
		}
	}

	const path = opts.path ?? conventionCapitalsPath()

	if (!(await pathExists(path))) {
		if (opts.missing === "degrade") {
			console.error(
				`[resolver] capital reference: none in the candidate artifact or at ${path} — capital promotion degrades to a no-op`
			)

			return undefined
		}

		throw new Error(
			`capital_tier is on, but neither the candidate artifact nor ${path} carries the capitals reference — ` +
				"pull a candidate.db that includes the `capital` table, or build the repo file with `mailwoman gazetteer capitals`"
		)
	}

	const parsed = await readLocalJSONFile<{ version?: number; entries?: CapitalPoint[] }>(path)

	if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
		throw new Error(`${path} is not a v1 capitals reference — rebuild with \`mailwoman gazetteer capitals\``)
	}

	// An entry without its folded name set would never match anything — an index that silently answers
	// `none` on every probe is the partial-reader lie, so a pre-name-set file is refused outright.
	if (parsed.entries.length && !Array.isArray(parsed.entries[0]?.k)) {
		throw new Error(`${path} predates the name-set field — rebuild with \`mailwoman gazetteer capitals\``)
	}

	return new CapitalIndex(parsed.entries)
}

/**
 * The WOF database paths that exist on disk — `explicit` when given, else the data-root convention set. The empty
 * answer is the caller's to interpret: a drop-in exits with the named-artifact message, a probe degrades.
 */
export async function existingWOFDatabasePaths(explicit?: readonly string[]): Promise<string[]> {
	const candidates = explicit ?? wofExtractPaths()
	const existing: string[] = []

	for (const databasePath of candidates) {
		if (await pathExists(databasePath)) {
			existing.push(databasePath)
		}
	}

	return existing
}

/**
 * Resolver artifact selection for the POI probe path: the candidate gazetteer when one resolves (worldwide, no WOF
 * database needed), else the WOF database set that exists on disk — an explicit comma-separated `--resolve-db` list
 * first, then the convention set. The empty answer is the caller's to interpret: `mailwoman poi` degrades with a stderr
 * note.
 */
export async function resolvePOIResolverPaths(options: {
	candidateDB?: string
	resolveDB?: string
}): Promise<{ candidateDB: string | undefined; wofPaths: string[] }> {
	const candidateDB = await resolveCandidateDBPath(options.candidateDB)

	if (candidateDB) return { candidateDB, wofPaths: [] }

	const explicit = options.resolveDB
		? options.resolveDB
				.split(",")
				.map((path) => path.trim())
				.filter((path) => path.length > 0)
		: undefined

	return { candidateDB, wofPaths: await existingWOFDatabasePaths(explicit) }
}

/**
 * The admin FTS database path a command requires: the explicit flag, else `$MAILWOMAN_WOF_DB`. Throws naming the build
 * command when neither is set.
 */
export async function requireWOFPath(explicit?: string): Promise<string> {
	const resolved = explicit ?? $public.MAILWOMAN_WOF_DB

	if (!resolved) {
		throw new Error(
			"No WOF database configured. Pass --resolve-db or set $MAILWOMAN_WOF_DB (build one with `mailwoman gazetteer build fts`)."
		)
	}

	return resolved
}
