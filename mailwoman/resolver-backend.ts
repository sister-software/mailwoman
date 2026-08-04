/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared resolver-backend selector for the CLI commands + server routers. Picks the byte-range
 *   CANDIDATE-table lookup ({@link WOFCandidateTableLookup}) — the SAME backend + population-first,
 *   country-agnostic ranking the browser demo uses — when a `candidate.db` is reachable, else the
 *   FTS admin lookup ({@link WOFSqlitePlaceLookup}).
 *
 *   Why this exists: the demo resolves localities population-first ("Moscow" → the 10.4 M-pop Russian
 *   city), but the FTS resolver ranks by bm25 + exact-match tiering, so a bare homonym goes to
 *   whichever same-name place bm25 floats up (often a small US township). The candidate table also
 *   carries 3.66 M postcodes and the exonym aliases that map `Munich` onto `München`, neither of
 *   which the FTS admin shard stocks.
 *
 *   The candidate table is the DEFAULT: {@link resolveCandidateDBPath} falls back to the convention
 *   path, so a pulled gazetteer is picked up with nothing exported. `MAILWOMAN_CANDIDATE_DB=none`
 *   (or `--candidate-db none`) pins the FTS backend.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { $public } from "@mailwoman/core/env"
import { mailwomanDataRoot } from "@mailwoman/core/utils"
import type {
	PlaceLookup,
	WOFCandidateTableLookup,
	WOFPostalCityAliasLookup,
	WOFSqlitePlaceLookup,
} from "@mailwoman/resolver-wof-sqlite"

/**
 * The candidate gazetteer's conventional home — where `mailwoman data pull candidate` writes it, and where every caller
 * looks when nothing points somewhere else.
 */
export function conventionCandidateDBPath(): string {
	return join(mailwomanDataRoot(), "wof", "candidate.db")
}

/**
 * Resolve the candidate-db path: an explicit option, then `$MAILWOMAN_CANDIDATE_DB`, then the convention path. Each is
 * used only if it exists on disk. `none` at either the explicit or the env position pins the FTS backend instead.
 *
 * The convention fallback is what makes the candidate table the DEFAULT backend. See
 * docs/engineering/reference/resolver-backends.mdx for the tier-1 measurement behind that default, the named residuals,
 * and the 2×2 any comparison between the two backends has to run.
 */
export function resolveCandidateDBPath(explicit?: string): string | undefined {
	const pinned = explicit ?? $public.MAILWOMAN_CANDIDATE_DB

	if (pinned === "none") return undefined

	if (pinned) return existsSync(pinned) ? pinned : undefined

	const convention = conventionCandidateDBPath()

	return existsSync(convention) ? convention : undefined
}

/**
 * Resolve the postal-city-alias-db path from an explicit option then `$MAILWOMAN_POSTAL_CITY_ALIAS_DB` (#475);
 * undefined if unset or missing. Only consulted on the FTS backend (the candidate backend folds aliases at build time,
 * not at query time).
 */
export function resolvePostalCityAliasDBPath(explicit?: string): string | undefined {
	const p = explicit ?? $public.MAILWOMAN_POSTAL_CITY_ALIAS_DB

	return p && existsSync(p) ? p : undefined
}

// The data-root helpers now live centrally in `@mailwoman/core/utils/data-root` — the ONE place the
// `/mnt/playpen` default appears. Re-exported here so the server routers + CLI commands keep
// importing them from this module unchanged.
export { dataRootPath, mailwomanDataRoot, wofShardPaths } from "@mailwoman/core/utils"

/**
 * The #1009 "no gazetteer data found" preflight message, shared by every caller that gates on a candidate/WOF resolver
 * being present before it will boot (`photon/cli.ts`, `nominatim/cli.ts`, `mailwoman/api-engine.ts`'s `mailwoman
 * serve`). Originally a bare `curl -fSL https://public.sister.software/...` line; measured 2026-08-03
 * (`mailwoman/data-bundles.ts`'s `downloadToDisk` docstring) that an UNRANGED GET against that bucket 403s — the hint
 * was broken for every stranger who copy-pasted it. `mailwoman data pull candidate` (Task 6) is the fix: it carries the
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
		`  Docs: https://mailwoman.sister.software${opts.docsPath}`,
	].join("\n")
}

/**
 * The lookup constructors this selector needs — a structural subset of `@mailwoman/resolver-wof-sqlite`.
 */
interface ResolverLookupModule {
	WOFSqlitePlaceLookup: typeof WOFSqlitePlaceLookup
	WOFCandidateTableLookup: typeof WOFCandidateTableLookup
	WOFPostalCityAliasLookup: typeof WOFPostalCityAliasLookup
}

/**
 * Build the resolver backend. `candidateDb` (explicit or env) → candidate-table lookup (demo-parity); otherwise the FTS
 * lookup over `wofPaths` (single path or admin+postcode shard list). On the FTS path, a configured postal-city-alias db
 * (#475) is attached so a postal city resolves to its geographic locality — opt-in, default-off (unset env →
 * byte-identical FTS path).
 */
export function createResolverBackend(
	mod: ResolverLookupModule,
	opts: { candidateDb?: string; wofPaths: string | string[]; postalCityAliasDB?: string }
): PlaceLookup {
	const candidate = resolveCandidateDBPath(opts.candidateDb)

	if (candidate) {
		console.error(`[resolver] candidate-table backend (demo-parity, population-first): ${candidate}`)

		return new mod.WOFCandidateTableLookup({ databasePath: candidate })
	}

	const wp = opts.wofPaths
	const aliasDB = resolvePostalCityAliasDBPath(opts.postalCityAliasDB)
	const postalCityAliases = aliasDB ? new mod.WOFPostalCityAliasLookup({ databasePath: aliasDB }) : undefined

	if (postalCityAliases) {
		console.error(`[resolver] postal-city alias scorer enabled (#475): ${aliasDB}`)
	}

	return new mod.WOFSqlitePlaceLookup({
		databasePath: Array.isArray(wp) && wp.length === 1 ? wp[0]! : wp,
		postalCityAliases,
	})
}
