/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates `data/venue-word-hints.json` from the venue-word lexicon under the data root. The
 *   output is a deterministic filter of the input, so regenerating from the same input gives the
 *   same bytes. The output records the source md5, and `data/provenance.md` describes the source.
 *
 *   The filter combines several thresholds because the venue ratio alone favors famous place
 *   names. Tokens such as `paris` appear often in venue names ("Café de Paris") and score a high
 *   venue ratio without being venue words.
 *
 *   Run `node packages/poi-taxonomy/lib/scripts/build-venue-word-hints.ts`, then format the output
 *   with `npx oxfmt packages/poi-taxonomy/data/venue-word-hints.json`.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { md5Hex } from "@mailwoman/core/hash"
import { parseJSONStrict } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { runIfScript } from "@mailwoman/core/scripting"
import { compareByCodePoint } from "@mailwoman/core/strings/compare"

import type { VenueWordHint, VenueWordHintTable } from "#venue-word-hints"

/**
 * The minimum venue ratio, `poi_rate / (poi_rate + place_rate)`, with both rates per million.
 */
export const VENUE_RATIO_MIN = 0.9

/**
 * The minimum number of occurrences in POI names.
 * Below this count the venue ratio is unreliable.
 */
export const POI_FREQ_MIN = 100

/**
 * The minimum share of the token's POI occurrences that fall in its top category class.
 *
 * The filter uses classes such as food or retail because a single token can separate a
 * food venue from a place name but rarely separates two restaurant categories.
 */
export const TOP_CLASS_SHARE_MIN = 0.7

/**
 * The maximum rate per million in primary place names.
 *
 * This threshold removes place names such as `paris`, which score above 6 ppm,
 * while venue words such as `cemetery` score near 2 ppm or below.
 */
export const PLACE_RATE_PPM_MAX = 5

interface SourceTokenRow {
	poi_freq: number
	poi_rate_ppm: number
	place_rate_ppm: number
	venue_ratio: number
	top_category: string | null
	top_category_share: number
	top_class: string | null
	top_class_share: number
}

interface SourceLexicon {
	provenance: unknown
	tokens: Record<string, SourceTokenRow>
}

/**
 * Filters the source lexicon by the thresholds above and returns the hint table sorted by token.
 */
export function buildVenueWordHintTable(source: SourceLexicon, sourceMD5: string): VenueWordHintTable {
	const hints: Record<string, VenueWordHint> = {}

	const qualifying = Object.entries(source.tokens).filter(
		([, row]) =>
			row.venue_ratio >= VENUE_RATIO_MIN &&
			row.poi_freq >= POI_FREQ_MIN &&
			typeof row.top_class === "string" &&
			row.top_class !== "other" &&
			row.top_class_share >= TOP_CLASS_SHARE_MIN &&
			row.place_rate_ppm <= PLACE_RATE_PPM_MAX
	)

	qualifying.sort(([a], [b]) => compareByCodePoint(a, b))

	for (const [token, row] of qualifying) {
		hints[token] = {
			topClass: row.top_class!,
			topClassShare: round4(row.top_class_share),
			topCategory: row.top_category,
			topCategoryShare: round4(row.top_category_share),
			venueRatio: round4(row.venue_ratio),
			poiFreq: row.poi_freq,
			placeRatePPM: round4(row.place_rate_ppm),
		}
	}

	return {
		version: 1,
		provenance: {
			source: "venue-word-lexicon-f6.json (f6 survey: Overture poi names vs candidate-gazetteer primary place names)",
			sourceMD5,
			bars: {
				venueRatioMin: VENUE_RATIO_MIN,
				poiFreqMin: POI_FREQ_MIN,
				topClassShareMin: TOP_CLASS_SHARE_MIN,
				placeRatePPMMax: PLACE_RATE_PPM_MAX,
			},
		},
		hints,
	}
}

function round4(n: number): number {
	return Math.round(n * 10_000) / 10_000
}

async function main(): Promise<void> {
	const sourcePath = dataRootPath("derived", "venue-word-lexicon-f6.json")
	const raw = await readLocalTextFile(sourcePath)
	const source = parseJSONStrict<SourceLexicon>(raw)
	const sourceMD5 = md5Hex(raw)

	const table = buildVenueWordHintTable(source, sourceMD5)
	const outPath = resolvePackagePath("@mailwoman/poi-taxonomy", "data", "venue-word-hints.json")

	await writeLocalJSONFile(table, outPath)

	console.log(
		`venue-word-hints: ${Object.keys(table.hints).length} tokens (source md5 ${sourceMD5.slice(0, 8)}) → ${outPath}`
	)
}

runIfScript(import.meta, main)
