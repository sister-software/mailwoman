/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Shared resolver-backend selector for the CLI commands + server routers. Picks the byte-range
 *   CANDIDATE-table lookup ({@link WofCandidateTableLookup}) — the SAME backend + population-first,
 *   country-agnostic ranking the browser demo uses — when a `candidate.db` is configured, else the
 *   FTS admin lookup ({@link WofSqlitePlaceLookup}, today's default).
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

import type { PlaceLookup, WofCandidateTableLookup, WofSqlitePlaceLookup } from "@mailwoman/resolver-wof-sqlite"
import { existsSync } from "node:fs"

/** Resolve the candidate-db path from an explicit option then `$MAILWOMAN_CANDIDATE_DB`; undefined
if unset or missing. */
export function resolveCandidateDbPath(explicit?: string): string | undefined {
	const p = explicit ?? process.env["MAILWOMAN_CANDIDATE_DB"]
	return p && existsSync(p) ? p : undefined
}

/** The lookup constructors this selector needs — a structural subset of
`@mailwoman/resolver-wof-sqlite`. */
interface ResolverLookupModule {
	WofSqlitePlaceLookup: typeof WofSqlitePlaceLookup
	WofCandidateTableLookup: typeof WofCandidateTableLookup
}

/**
 * Build the resolver backend. `candidateDb` (explicit or env) → candidate-table lookup
 * (demo-parity); otherwise the FTS lookup over `wofPaths` (single path or admin+postcode shard
 * list).
 */
export function createResolverBackend(
	mod: ResolverLookupModule,
	opts: { candidateDb?: string; wofPaths: string | string[] }
): PlaceLookup {
	const candidate = resolveCandidateDbPath(opts.candidateDb)
	if (candidate) {
		console.error(`[resolver] candidate-table backend (demo-parity, population-first): ${candidate}`)
		return new mod.WofCandidateTableLookup({ databasePath: candidate })
	}
	const wp = opts.wofPaths
	return new mod.WofSqlitePlaceLookup({ databasePath: Array.isArray(wp) && wp.length === 1 ? wp[0]! : wp })
}
