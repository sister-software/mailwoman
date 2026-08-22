/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file The harvest side of the sub-venue lexicon: what one row of a harvestable source looks like,
 *   how a file of them is read back, and what a pass over them extracts — attested surfaces plus the
 *   measured shape of each designator's identifier half.
 *
 *   {@link SubVenueHarvestRow} is SOURCE-NEUTRAL, and verified so: an Overture Places row from the
 *   `airport_terminal` category is `{ designatorID, name }` and fits unchanged. It is declared here
 *   rather than imported so the builder does not take a dependency on `@mailwoman/osm` (which
 *   `@mailwoman/corpus` does not depend on) just to name a shape it reads from a file.
 *
 *   Two measurements shape {@link extractAttestedPhrases}, and both are the reason it is safe to run
 *   over raw OSM at all:
 *
 *   **A feature's `name` is usually the VENUE's name, not a sub-venue phrase.** On the Berlin extract
 *   (2,060 matched features) a `railway=platform` is named `Stendaler Straße` and an `amenity=university`
 *   is named `Hertie School`; across 250,116 named Great Britain features only 6,003 (2.40%) contain a
 *   designator token at all. So names are not harvested wholesale — a name contributes only when it
 *   CONTAINS a phrase already in the surface index, which is what makes `Terminal E (Untere Ebene)`
 *   evidence and `Otto Lilienthal Flughafen Berlin Tegel` not.
 *
 *   **A matched phrase belongs to the record the PHRASE names, not the record the ROW carries.**
 *   Attributing every hit to `row.designatorID` — the rule that matched the FEATURE — produced `west →
 *   platform`, `hall → platform` and `biggin → platform` on the GB extract, because a bus stop tagged
 *   `public_transport=platform` is named "Village Hall" or "West Kensington"; 108 of 133 OSM-derived
 *   surfaces named a different record than the one they pointed at. Attribution therefore runs through
 *   the index, and the row's own designator is kept as `context` — exactly the axis a confound board
 *   needs, since a `hall` seen on a platform is a confound and a `hall` seen on a terminal is evidence.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { TextSpliterator } from "spliterator"

import { nameContainsSurfaces, type SurfaceIndex } from "./surfaces.ts"
import type { IdentifierShape, SubVenueSurface } from "./table.ts"

/**
 * One row of a harvestable source, as read back off JSONL or out of a layer database.
 *
 * SOURCE-NEUTRAL by design, and verified so in wave 2: an Overture Places row from the `airport_terminal` category is
 * `{ designatorID, name }` and fits unchanged. What did NOT fit was the harvest function's hardcoded `osm:name` source
 * stamp — see `overture-subvenue.ts`'s docstring. Declared locally so the builder does not import `@mailwoman/osm`
 * (which `@mailwoman/corpus` does not depend on) just to name a shape it reads from a file.
 */
export interface SubVenueHarvestRow {
	/**
	 * The designator the SOURCE's rule assigned to the FEATURE. Not necessarily the record a matched phrase names — see
	 * this file's header on phrase attribution. Carried into {@link SubVenueSurface.context}.
	 */
	designatorID: string
	/**
	 * `venue` (station, airport, campus) or `sub_venue`, when the source's rule assigns one. The harvest itself does not
	 * read it; the sub-venue shard recipe fills its venue slot from it.
	 */
	tier?: string
	name?: string | null
	ref?: string | null
	localizedNames?: Record<string, string>
}

/**
 * Classify an OSM `ref` into an {@link IdentifierShape} class.
 *
 * The classes are the ones Berlin's gates actually produced, plus the two aviation forms the corpus task names
 * (`Terminal 2F` is digit-letter, `Concourse B` is letter). `range` covers both separators OSM uses for a gate serving
 * more than one stand: `16-18` and `0/1`.
 */
export function classifyIdentifier(ref: string): string {
	const value = ref.trim()

	if (/^[0-9]+$/.test(value)) return "digit"

	if (/^[A-Za-z]$/.test(value)) return "letter"

	if (/^[A-Za-z]+[0-9]+$/.test(value)) return "letter-digit"

	if (/^[0-9]+[A-Za-z]+$/.test(value)) return "digit-letter"

	if (/^[0-9A-Za-z]+\s*[-/]\s*[0-9A-Za-z]+$/.test(value)) return "range"

	return "other"
}

/**
 * How many real `ref` values each {@link IdentifierShape} keeps.
 *
 * Eight, not "all" and not one. The field exists so a shard author can see what a class actually CONTAINS — GB's
 * `other` class turned out to be semicolon multi-values (`1;2;3`, `13;14`), which one example would have hidden and
 * which the class name does not say. Eight fits a terminal line and covers the variety inside every class the GB
 * extract produced. The COUNT lives in `observations`; this is a sample, not a census.
 */
const IDENTIFIER_EXAMPLES_PER_SHAPE = 8

/**
 * Options for one harvest pass — which source stamp its surfaces carry and which region they were attested in.
 *
 * Both default to the OSM/unknown-region values wave 1 hardcoded, so an existing caller is unchanged.
 */
export interface HarvestOptions {
	/**
	 * Source family: `osm` yields `osm:name` / `osm:name:<lang>`, `overture` yields `overture:name`.
	 */
	source?: string
	/**
	 * ISO 3166-1 alpha-2 of the extract or partition. `""` when unknown.
	 */
	region?: string
}

/**
 * Harvest attested phrases and identifier shapes out of a source's rows.
 *
 * `index` gates the name harvest — a name contributes only when it CONTAINS a phrase already in the table. That filter
 * is the whole reason this function is safe to run over raw OSM: see this file's header for the Berlin measurement that
 * motivated it. The index also decides ATTRIBUTION: a hit is a surface of the record the PHRASE names, and the row's
 * own designator is recorded as `context`.
 *
 * Returns surfaces with real `observations` counts, so the lexicon can rank `terminal` above a phrase attested once.
 */
export function extractAttestedPhrases(
	rows: Iterable<SubVenueHarvestRow>,
	index: SurfaceIndex,
	options: HarvestOptions = {}
): { surfaces: SubVenueSurface[]; identifierShapes: IdentifierShape[] } {
	const source = options.source ?? "osm"
	const region = options.region ?? ""
	/**
	 * `phrase\0lang\0source` → { count, context }.
	 */
	const surfaceCounts = new Map<string, { count: number; context: Map<string, number> }>()
	/**
	 * `designatorID\0shape` → { count, examples }.
	 */
	const shapes = new Map<string, { count: number; examples: Set<string> }>()

	const note = (phrase: string, lang: string, sourceTag: string, context: string): void => {
		const key = `${phrase}\0${lang}\0${sourceTag}`
		const entry = surfaceCounts.get(key) ?? { count: 0, context: new Map<string, number>() }

		entry.count++
		entry.context.set(context, (entry.context.get(context) ?? 0) + 1)
		surfaceCounts.set(key, entry)
	}

	for (const row of rows) {
		if (row.name) {
			for (const hit of nameContainsSurfaces(row.name, index)) {
				// `und` — the default `name` tag carries no language. Overture's `name` is the same: a
				// primary name in whatever language the place uses, untagged.
				note(hit, "und", `${source}:name`, row.designatorID)
			}
		}

		for (const [lang, localized] of Object.entries(row.localizedNames ?? {})) {
			for (const hit of nameContainsSurfaces(localized, index)) {
				note(hit, lang, `${source}:name:${lang}`, row.designatorID)
			}
		}

		if (row.ref) {
			const shape = classifyIdentifier(row.ref)
			const key = `${row.designatorID}\0${shape}`
			const entry = shapes.get(key) ?? { count: 0, examples: new Set<string>() }

			entry.count++

			if (entry.examples.size < IDENTIFIER_EXAMPLES_PER_SHAPE) {
				entry.examples.add(row.ref.trim())
			}

			shapes.set(key, entry)
		}
	}

	const surfaces: SubVenueSurface[] = [...surfaceCounts].map(([key, entry]) => {
		const [phrase, lang, sourceTag] = key.split("\0") as [string, string, string]
		const record = index.get(phrase)!

		return {
			phrase,
			recordID: record.recordID,
			recordKind: record.recordKind,
			lang,
			region,
			source: sourceTag,
			curated: false,
			observations: entry.count,
			context: Object.fromEntries([...entry.context].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
		}
	})

	const identifierShapes: IdentifierShape[] = [...shapes].map(([key, entry]) => {
		const [designatorID, shape] = key.split("\0") as [string, string]

		return {
			designatorID,
			region,
			shape,
			observations: entry.count,
			examples: [...entry.examples].toSorted((a, b) => a.localeCompare(b)),
		}
	})

	return { surfaces, identifierShapes }
}

/**
 * Read a JSONL file of {@link SubVenueHarvestRow}s. Blank lines and unparseable rows are skipped rather than fatal — an
 * extract is a build output, and one malformed line should not cost the whole lexicon.
 */
export function readSubVenueJSONL(path: string): SubVenueHarvestRow[] {
	const out: SubVenueHarvestRow[] = []

	// `TextSpliterator` rather than `split("\n")` — a whole-country extract runs to 250,000 lines
	// (52 MB for Great Britain), and materializing every segment before reading the first is exactly
	// what the repo lint rule exists to prevent.
	for (const line of TextSpliterator.from(readFileSync(path, "utf8"))) {
		const trimmed = line.trim()

		if (!trimmed) continue

		try {
			out.push(parseJSONStrict<SubVenueHarvestRow>(trimmed))
		} catch {
			continue
		}
	}

	return out
}
