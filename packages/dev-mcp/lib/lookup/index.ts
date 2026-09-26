/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Ask a data source directly: does it know this string, and what does it say?
 *
 *   A resolve returning no result has two causes that look identical from the outside — the parser never asked, or the
 *   gazetteer has no answer — so this module keeps the readings apart:
 *
 *   - `hit: false, entries: null` — the source does not know the string. Absence.
 *   - `hit: true` with a zero-valued entry — the source knows it and scores it zero. A measured zero.
 *   - `hit: true, entries: []` — accepted, but with no data the consumer can act on (for the FST: no BIO-mapped placetype).
 *
 *   The FST collapse is the decoder's own `collapseFSTBias`, not re-derived here.
 */

import { pathExists, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { stringifyJSON } from "@mailwoman/core/json"
import { collapseFSTBias } from "@mailwoman/neural/fst-prior"
import { normalize } from "@mailwoman/normalize"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import type { PathBuilderLike } from "path-ts"

/**
 * Sources a lookup can address.
 *
 * Each answers a different "does it know this?" and they are not interchangeable: a surface the
 * FST accepts can still be absent from the candidate table, the shape most resolve failures take.
 */
export const LookupSource = {
	/**
	 * The gazetteer FST the emission prior reads, answering what bias the decoder would receive.
	 */
	FST: "fst",
	/**
	 * The street-morphology FST — whether a token reads as a generic street word.
	 */
	StreetMorphology: "street_morphology",
	/**
	 * Stage-1 deterministic preprocessing: what the model is actually FED, which is not what the user typed.
	 */
	Normalize: "normalize",
	/**
	 * The candidate gazetteer (`candidate.db`), the default resolver backend,
	 * keyed on `name_key`, never `name`.
	 */
	Candidate: "candidate",
	/**
	 * Answers what the source data holds, including the deprecated records the
	 * resolver's own query filters out.
	 */
	WOF: "wof",
	/**
	 * `poi.db`, the POI layer the fork→entity probe reads, keyed on `name_key` like the candidate table.
	 */
	POI: "poi",
	/**
	 * The pure postal reference tables (postcode shapes, USPS suffixes, unit designators,
	 * directionals, US states); no artifact, so it can never be unavailable.
	 */
	Codex: "codex",
	/**
	 * The postcode→anchor artifact in the resolved weights package — a channel
	 * the model is fed rather than a gazetteer.
	 */
	Postcode: "postcode",
} as const

export type LookupSource = (typeof LookupSource)[keyof typeof LookupSource]

export interface LookupRow {
	query: string
	/**
	 * `false` is absence and must never be read as a zero.
	 */
	hit: boolean
	/**
	 * `null` when `hit` is false, absent rather than empty so a caller cannot iterate
	 * a "zero results" list that was really a miss.
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
	 * The resolved path plus whatever else decides the reading
	 * (the locale and declared span mode for the anchor, the engine for the FST); absent
	 * when there was no artifact to name, such as `codex`/`normalize`.
	 */
	provenance?: Record<string, unknown>
	/**
	 * Absent when the artifact could not be opened — reported rather than degraded, because
	 * answering "no" to every query because a file is missing is the worst possible answer.
	 */
	unavailable_reason?: string
	/**
	 * Present instead OF `rows` for a sweep; a locale whose artifact is missing carries
	 * its own `unavailable_reason` rather than dropping out, because a locale absent
	 * from the map would read as one the source did not know.
	 */
	by_locale?: Record<string, { artifact?: string; rows: LookupRow[]; unavailable_reason?: string }>
	notes: string[]
}

interface FSTLike {
	walk(tokens: string[]): { stateID: number; accepted: boolean } | null
	accepting(stateID: number): Array<{ wofID: number; placetype: string; referential?: number; importance?: number }>
}

/**
 * Reports the collapse the decoder would see rather than the raw entry list: the emission
 * prior takes `max(importance)` per BIO tag and only four placetypes reach a tag at all,
 * so anything finer would overstate what the gazetteer can do.
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
 * A single-token question, so a multi-word query is a caller error worth naming.
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
 * Always a hit, since normalization has an answer for every string; the value is the diff,
 * because a query whose normalized form differs from what was typed is the most
 * common reason a lookup elsewhere "inexplicably" misses.
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
				: { note: `Normalization changed the input — downstream sources see ${stringifyJSON(normalized)}.` }),
		}
	})
}

/**
 * Opens read-only as the interface, not as a precaution: every built database in
 * this repo is sealed 0444 and never modified, so a read-write open would fail on a
 * correctly-sealed artifact and succeed on one that was not.
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
 * Load an FST artifact, reporting a missing file as unavailable rather than as a source with no entry.
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
