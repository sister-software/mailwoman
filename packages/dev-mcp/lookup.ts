/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ask a data source directly: does it know this string, and what does it say?
 *
 *   This is the question four one-off probes were written to answer in a single day — `icu-probe.mjs`, `keynorm-probe`,
 *   `probe-fst-bias`, and the ad-hoc FST walks that settled the San Juan and Sultan Qaboos cases. It is also the
 *   question that most often precedes a wrong conclusion, because a resolve that returns nothing has two causes that
 *   look identical from the outside: the parser never asked, or the gazetteer has no answer.
 *
 *   **The distinction this module exists to keep:**
 *
 *   - `hit: false, entries: null` — the source does not know the string. ABSENCE.
 *   - `hit: true` with a zero-valued entry — the source knows it and scores it zero. A MEASURED ZERO.
 *   - `hit: true, entries: []` — accepted, but nothing the consumer can act on (for the FST: no BIO-mapped placetype).
 *
 *   `probe-fst-bias.run.ts` already documents the first two for the FST case and this generalizes them. Nothing here
 *   re-derives what a consumer reads: the FST collapse is `collapseFSTBias`, the decoder's own function.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalize } from "@mailwoman/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * Sources a lookup can address. Each answers a different "does it know this?" and they are not interchangeable — a
 * surface the FST accepts can still be absent from the candidate table, which is the shape most resolve failures take.
 */
export const LookupSource = {
	/**
	 * The gazetteer FST the emission prior reads. Answers what BIAS the decoder would receive.
	 */
	FST: "fst",
	/**
	 * The street-morphology FST — whether a token reads as a generic street word.
	 */
	StreetMorphology: "street_morphology",
	/**
	 * Stage-1 deterministic preprocessing. Answers what the model is actually FED, which is not what the user typed.
	 */
	Normalize: "normalize",
	/**
	 * The candidate gazetteer (`candidate.db`) — the default resolver backend. Keyed on `name_key`, never `name`.
	 */
	Candidate: "candidate",
	/**
	 * The WOF admin + postcode shards behind the FTS backend. Answers what the SOURCE data holds, including the
	 * deprecated records the resolver's own query filters out.
	 */
	WOF: "wof",
	/**
	 * `poi.db` — the POI layer the fork→entity probe reads. Keyed on `name_key` like the candidate table.
	 */
	POI: "poi",
	/**
	 * `@mailwoman/codex` — the pure postal reference tables. Postcode SHAPES, USPS suffixes, unit designators,
	 * directionals, US states. No artifact, so it can never be unavailable.
	 */
	Codex: "codex",
	/**
	 * The postcode→anchor artifact in the resolved weights package — the channel the MODEL is fed, not a gazetteer.
	 */
	Postcode: "postcode",
} as const

export type LookupSource = (typeof LookupSource)[keyof typeof LookupSource]

export interface LookupRow {
	query: string
	/**
	 * Whether the source knows the string at all. `false` is absence and must never be read as a zero.
	 */
	hit: boolean
	/**
	 * What the source says. `null` when `hit` is false — the field is absent rather than empty, so a caller cannot
	 * accidentally iterate a "zero results" list that was really a miss.
	 */
	entries: unknown[] | null
	/**
	 * A reading of this row in words, for the cases where the shape alone misleads.
	 */
	note?: string
}

export interface LookupResult {
	source: LookupSource
	rows: LookupRow[]
	/**
	 * WHICH artifact answered — the resolved path, plus whatever else decides the reading (the locale and declared span
	 * mode for the anchor, the engine for the FST). Absent when there was no artifact to name: the unavailable envelope
	 * says why in `unavailable_reason`, and `codex`/`normalize` read no file at all.
	 */
	provenance?: Record<string, unknown>
	/**
	 * Absent when the source's artifact could not be opened. Reported rather than degraded, because a lookup that
	 * silently answers "no" for every query because a file is missing is the worst possible answer.
	 */
	unavailable_reason?: string
	/**
	 * One entry per locale when several were asked for — the same queries against each locale's own artifact.
	 *
	 * Present INSTEAD OF `rows` for a sweep. A locale whose artifact is missing carries its own `unavailable_reason` here
	 * rather than dropping out of the map: five shipped overlays ship no FST at all, and a locale absent from the result
	 * reads as a locale that knew nothing.
	 */
	by_locale?: Record<string, { artifact?: string; rows: LookupRow[]; unavailable_reason?: string }>
	notes: string[]
}

interface FSTLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; referential?: number; importance?: number }>
}

/**
 * Probe the gazetteer FST, reporting the collapse the DECODER would see rather than the raw entry list.
 *
 * The per-place ranking inside a name is invisible to the emission prior — it takes `max(importance)` per BIO tag, and
 * only four placetypes reach a tag at all. Reporting anything finer would overstate what the gazetteer can do here.
 */
export function lookupFST(
	fst: FSTLike,
	normalizeTokens: (surface: string) => string[],
	queries: string[]
): LookupRow[] {
	return queries.map((query) => {
		const match = fst.walk(normalizeTokens(query))

		if (!match?.accepted) {
			return {
				query,
				hit: false,
				entries: null,
				note: "The FST does not accept this surface. The gazetteer has nothing to say — absence, not a zero bias.",
			}
		}

		const raw = fst.accepting(match.stateID)

		const collapsed = collapseFSTBias(
			raw.map((e) => ({ placetype: e.placetype, importance: e.referential ?? e.importance ?? 0 })),
			normalizeTokens(query)
		)

		const entries = [...collapsed].map(([tag, importance]) => ({ tag, importance, fires: importance > 0 }))
		const firing = entries.filter((entry) => entry.fires)
		const plural = raw.length === 1 ? "y" : "ies"

		return {
			query,
			hit: true,
			entries,
			note: !collapsed.size
				? `Accepted with ${raw.length} entr${plural}, but none carries a BIO-mapped placetype ` +
					"(localadmin / county / borough / neighbourhood are walked and dropped), so the decoder receives NOTHING " +
					"from this surface. That is different from a zero."
				: firing.length
					? `Accepted with ${raw.length} entr${plural}; the decoder sees the per-tag max above.`
					: `Accepted with ${raw.length} entr${plural} carrying a BIO-mapped placetype, ALL at importance 0, so ` +
						"the prior is INERT on this surface: `applyBias` computes `importance * biasScale * maxBias * …` and " +
						"keeps a tag only when that exceeds the running max, which starts at 0. Present in the gazetteer and " +
						"contributing nothing are different facts.",
		}
	})
}

/**
 * Probe the street-morphology FST — a single-token question, so a multi-word query is a caller error worth naming.
 */
export function lookupStreetMorphology(fst: FSTLike, queries: string[]): LookupRow[] {
	return queries.map((query) => {
		const tokens = query.trim().split(/\s+/)
		const accepted = fst.walk(tokens) !== null

		return {
			query,
			hit: accepted,
			entries: accepted ? [{ generic: true, tokens }] : null,
			...(tokens.length > 1
				? { note: `Walked as ${tokens.length} tokens; this source answers about single generic street words.` }
				: {}),
		}
	})
}

/**
 * Show what Stage 1 actually hands the model.
 *
 * Always a hit: normalization has an answer for every string. The value is the DIFF — a query whose normalized form
 * differs from what was typed is the most common reason a lookup against another source "inexplicably" misses.
 */
export function lookupNormalize(queries: string[], locale: string): LookupRow[] {
	return queries.map((query) => {
		const { normalized } = normalize(query, { expandAbbreviations: true, locale })

		return {
			query,
			hit: true,
			entries: [{ normalized, changed: normalized !== query }],
			...(normalized === query
				? {}
				: { note: `Normalization changed the input — downstream sources see ${JSON.stringify(normalized)}.` }),
		}
	})
}

/**
 * Open a sealed SQLite artifact READ-ONLY, reporting a missing or unopenable file as unavailable rather than as a
 * source that knows nothing.
 *
 * `readOnly: true` is not a precaution here, it is the contract: every built database in this repo is sealed 0444 and
 * is never modified after creation, so a read-write open would fail on a correctly-sealed artifact and succeed — with a
 * journal file beside it — on one that was not.
 */
export async function openSealedArtifact<DB>(
	path: string | undefined
): Promise<{ db: DatabaseClient<DB> } | { unavailable: string }> {
	if (!path) return { unavailable: "No artifact path was resolved for this source." }

	if (!(await pathExists(path))) return { unavailable: `Artifact not found at ${path}.` }

	try {
		return { db: new DatabaseClient<DB>(path, { readOnly: true }) }
	} catch (error) {
		return { unavailable: `Artifact at ${path} could not be opened read-only: ${(error as Error).message}` }
	}
}

/**
 * Load an FST artifact, reporting a missing file as unavailable rather than as a source that knows nothing.
 */
export async function loadFSTArtifact(
	path: PathBuilderLike | undefined,
	deserialize: (buffer: Buffer) => FSTLike
): Promise<{ fst: FSTLike } | { unavailable: string }> {
	if (!path) return { unavailable: "No artifact path was resolved for this source." }

	if (!(await pathExists(path))) return { unavailable: `Artifact not found at ${path}.` }

	try {
		return { fst: deserialize(await readLocalBuffer(path)) }
	} catch (error) {
		return { unavailable: `Artifact at ${path} did not deserialize: ${(error as Error).message}` }
	}
}
