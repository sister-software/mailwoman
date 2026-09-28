/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   @file This module defines harvestable source rows and reads them from files. Each pass extracts
 *   attested surfaces and measures the identifier half of each designator.
 *
 *   {@link SubVenueHarvestRow} accepts rows from any source. An Overture Places row in the
 *   `airport_terminal` category has the shape `{ designatorID, name }` and fits unchanged. The type is
 *   declared here so the builder can read source rows without importing `@mailwoman/osm`. The corpus
 *   package has no dependency on that package.
 *
 *   Two measurements shape {@link extractAttestedPhrases}. They show why it can run over raw OSM:
 *
 *   **Most feature names describe the venue.** In the Berlin extract, 2,060 matched features include a
 *   `railway=platform` with the name `Stendaler Straße`. An `amenity=university` has the name `Hertie School`.
 *   Among 250,116 Great Britain features with names, 6,003 (2.40%) contain a designator token. A name adds a surface
 *   when it contains a phrase already in the surface index. `Terminal E (Untere Ebene)` qualifies. The full
 *   venue name `Otto Lilienthal Flughafen Berlin Tegel` does not.
 *
 *   **The matched phrase determines which record receives the surface.** Attributing every hit to
 *   `row.designatorID`, the rule that matched the feature, produced `west → platform`, `hall → platform`, and
 *   `biggin → platform` on the GB extract. A bus stop tagged `public_transport=platform` can carry the label
 *   "Village Hall" or "West Kensington". Of 133 OSM-derived surfaces, 108 referred to records other than the
 *   ones identified by the phrases. Attribution now follows the surface index. The row's designator stays in `context`.
 *   A confound board can then distinguish `hall` found on a platform from `hall` found on a terminal.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/json"
import { TextSpliterator } from "spliterator"

import { nameContainsSurfaces, type SurfaceIndex } from "#tools/sub/venue/surfaces"
import type { IdentifierShape, SubVenueSurface } from "#tools/sub/venue/table"

/**
 * One row of a harvestable source, as read back off jsonl or out of a layer database.
 *
 * This type accepts rows from any source.
 * An Overture Places row in the `airport_terminal` category has the shape
 * `{ designatorID, name }` and fits unchanged.
 *
 * The harvest function's hardcoded `osm:name` source stamp did not fit that input.
 * See `overture-subvenue.ts` for the source handling.
 *
 * Declared locally so the builder does not import `@mailwoman/osm`
 * (which `@mailwoman/corpus` does not depend on) just to name a shape it reads from a file.
 */
export interface SubVenueHarvestRow {
	/**
	 * The designator the source's rule assigned to the feature.
	 *
	 * Not necessarily the record a matched phrase names.
	 * See this file's header on phrase attribution.
	 * Carried into {@link SubVenueSurface.context}.
	 */
	designatorID: string
	/**
	 * `venue` (station, airport, campus) or `sub_venue`, when the source's rule assigns one.
	 *
	 * The harvest itself does not read it.
	 * The sub-venue recipe fills its venue slot from it.
	 */
	tier?: string
	name?: string | null
	ref?: string | null
	localizedNames?: Record<string, string>
}

/**
 * Classify an OSM `ref` into an {@link IdentifierShape} class.
 *
 * The classes are the ones Berlin's gates actually produced, plus the two aviation forms
 * the corpus task names (`Terminal 2F` is digit-letter, `Concourse B` is letter).
 * `range` covers both separators OSM uses for a gate serving more than one stand: `16-18` and `0/1`.
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
 * Eight rather than "all" and not one.
 * The field exists so a recipe author can see what a class actually contains.
 *
 * GB's `other` class turned out to be semicolon multi-values (`1.2.3`, `13.14`),
 * which one example would have hidden and which the class name does not say.
 *
 * Eight fits a terminal line and covers the variety inside every class the GB extract produced.
 * The count lives in `observations`; this is a sample rather than a census.
 */
const IDENTIFIER_EXAMPLES_PER_SHAPE = 8

/**
 * Options for one harvest pass.
 *
 * They set the source stamp and region recorded on each surface.
 *
 * Both default to the OSM/unknown-region values wave 1 hardcoded, so an existing caller is unchanged.
 */
export interface HarvestOptions {
	/**
	 * Source family: `osm` yields `osm:name` / `osm:name:<lang>`, `overture` yields `overture:name`.
	 */
	source?: string
	/**
	 * ISO 3166-1 alpha-2 of the extract or partition.
	 *
	 * `""` when unknown.
	 */
	region?: string
}

/**
 * Harvest attested phrases and identifier shapes out of a source's rows.
 *
 * `index` gates the name harvest.
 * A name contributes only when it contains a phrase already in the table.
 *
 * That filter is the whole reason this function is safe to run over raw OSM:
 * see this file's header for the Berlin measurement that motivated it.
 *
 * The index decides which record receives each hit.
 * The row's designator is recorded as `context`.
 *
 * @returns Surfaces with real `observations` counts, so the lexicon can rank
 * `terminal` above a phrase attested once.
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
				// `und` — the default `name` tag carries no language.
				// Overture's `name` is the same: a primary name in whatever language the place uses, untagged.
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
 * Read a jsonl file of {@link SubVenueHarvestRow}s.
 *
 * The reader skips blank lines and rows it cannot parse.
 * A malformed line does not stop lexicon generation.
 */
export async function readSubVenueJSONL(path: string): Promise<SubVenueHarvestRow[]> {
	const out: SubVenueHarvestRow[] = []

	// `TextSpliterator` rather than `split("\n")`.
	// A whole-country extract runs to 250,000 lines (52 MB for Great Britain), and materializing
	// every segment before reading the first is exactly what the repo lint rule exists to prevent.
	for (const line of TextSpliterator.from(await readLocalTextFile(path))) {
		try {
			out.push(parseJSONStrict<SubVenueHarvestRow>(line))
		} catch {
			continue
		}
	}

	return out
}
