/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared resolver-backend selector for the CLI commands + server routers. Picks the byte-range
 *   CANDIDATE-table lookup ({@link WOFCandidateTableLookup}) — the SAME backend + population-first,
 *   country-agnostic ranking the browser demo uses — when a `candidate.db` is configured, else the
 *   FTS admin lookup ({@link WOFSqlitePlaceLookup}, today's default).
 *
 *   Why this exists: the demo resolves localities population-first ("Moscow" → the 10.4 M-pop Russian
 *   city), but the FTS resolver ranks by bm25 + exact-match tiering, so a bare homonym goes to
 *   whichever same-name place bm25 floats up (often a small US township). Pointing the CLI/server
 *   at the candidate table makes them resolve identically to the demo. On the US held-out eval the
 *   candidate backend is a strict improvement over FTS (locality 96.8 → 97.3 %, coord p99 692 → 28
 *   km) while adding global coverage, so it's safe to opt into.
 *
 *   Opt-in via `MAILWOMAN_CANDIDATE_DB` (or an explicit `--candidate-db` on commands that expose it).
 *   Unset → the FTS backend, unchanged. Flip the env to make the CLI/server match the demo.
 */

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import type {
	PlaceLookup,
	WOFCandidateTableLookup,
	WOFPostalCityAliasLookup,
	WOFSqlitePlaceLookup,
} from "@mailwoman/resolver-wof-sqlite"

/**
 * Resolve the candidate-db path from an explicit option then `$MAILWOMAN_CANDIDATE_DB`; undefined if unset or missing.
 */
export function resolveCandidateDBPath(explicit?: string): string | undefined {
	const p = explicit ?? $public.MAILWOMAN_CANDIDATE_DB

	return p && existsSync(p) ? p : undefined
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

	if (postalCityAliases) console.error(`[resolver] postal-city alias scorer enabled (#475): ${aliasDB}`)

	return new mod.WOFSqlitePlaceLookup({
		databasePath: Array.isArray(wp) && wp.length === 1 ? wp[0]! : wp,
		postalCityAliases,
	})
}
