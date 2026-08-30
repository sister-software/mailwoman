/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generator for `data/venue-word-hints.json` — the MINED single-token venue-class hint table, the
 *   narrow slice of the f6 venue-word survey that earned committing. One derived input (the f6
 *   lexicon artifact under the data root), one committed output; the slice is a pure filter, so a
 *   regenerate against the same input is byte-identical.
 *
 *   ── Why a COMPOSED measure, not the venue ratio alone ────────────────────────────────────────────
 *   The survey's headline finding is that venue-frequency alone is toponym-saturated: famous-place
 *   tokens appear 35–60× denser in venue names than in place names ("Café de Paris", "Hotel México"),
 *   so `paris` scores a venue ratio of 0.973 — higher than `comer`'s 0.954 — while meaning nothing
 *   venue-like. Three bars compose the slice, and each kills a distinct false-positive family:
 *
 *   • {@linkcode VENUE_RATIO_MIN} + {@linkcode POI_FREQ_MIN} — the token is attested in venue names
 *     at rate, not by accident of a small denominator.
 *   • {@linkcode TOP_CLASS_SHARE_MIN} (and `top_class ≠ "other"`) — the token predicts a CLASS, not
 *     just "venues generally". This is what makes an entry a hint a consumer can act on.
 *   • {@linkcode PLACE_RATE_PPM_MAX} — the toponym suppressor. The falsifier's named street-fork
 *     false positives sit at 6.8–17.4 ppm in place names (catherine 6.8, augusta 11.2, mexico 12.2,
 *     paris 17.4); genuine venue words sit at ≤ ~2 (comer 0.8, kfc 0.0, cemetery 2.04). The bar
 *     sits in the measured gap.
 *
 *   Measured at these bars: 2,249 tokens (food 997, retail 904, civic 187, health 52, lodging 48,
 *   transit 45, burial 16), ZERO of the falsifier's street-fork false positives ('augusta',
 *   'catherine', 'savile', …) and none of the toponym family ('paris', 'mexico'). `comer` — the
 *   torture entry that motivated the survey — does NOT pass: its category mass splits across
 *   food/retail/other (top class share 0.46), which is exactly the composed-measure honesty the
 *   trained-channel design needs; it stays with that deferred lever, not in this table.
 *
 *   Run: `node poi-taxonomy/scripts/build-venue-word-hints.ts && npx oxfmt poi-taxonomy/data/venue-word-hints.json`
 *   (committed JSON is oxfmt-clean, the repo law). The source artifact is data-root local (built by
 *   the f6 survey against the Overture poi corpus + the candidate gazetteer's primary names); its
 *   md5 is recorded in the output's provenance block, and `data/PROVENANCE.md` carries the rest.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { runIfScript } from "@mailwoman/core/scripting"
import { dataRootPath } from "@mailwoman/core/utils"
import { createHash } from "@mailwoman/platform/crypto"
import { resolve } from "@mailwoman/platform/path"

import type { VenueWordHint, VenueWordHintTable } from "../venue-word-hints.ts"

/**
 * Minimum share of the token's venue-vs-place per-million rate mass (`poi_rate / (poi_rate + place_rate)`).
 */
export const VENUE_RATIO_MIN = 0.9

/**
 * Minimum absolute occurrences in the poi-name corpus — below this the ratio is a small-denominator artifact.
 */
export const POI_FREQ_MIN = 100

/**
 * Minimum share of the token's poi occurrences held by its top category CLASS. The class grain (food, retail, civic, …)
 * is deliberate: single-token evidence rarely separates `mexican_restaurant` from `taco_restaurant`, but reliably
 * separates "this names a food venue" from "this names a place".
 */
export const TOP_CLASS_SHARE_MIN = 0.7

/**
 * Maximum per-million rate in PRIMARY place names — the toponym suppressor (see the header for the measured gap).
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
 * Apply the composed bars. Pure, deterministic, sorted by token — the byte-identity contract.
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

	qualifying.sort(([a], [b]) => a.localeCompare(b, "en"))

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
	const sourcePath = String(dataRootPath("derived", "venue-word-lexicon-f6.json"))
	const raw = await readLocalTextFile(sourcePath)
	const source = parseJSONStrict<SourceLexicon>(raw)
	const sourceMD5 = createHash("md5").update(raw).digest("hex")

	const table = buildVenueWordHintTable(source, sourceMD5)
	const outPath = resolve(import.meta.dirname, "../data/venue-word-hints.json")

	await writeLocalJSONFile(table, outPath)

	console.log(
		`venue-word-hints: ${Object.keys(table.hints).length} tokens (source md5 ${sourceMD5.slice(0, 8)}) → ${outPath}`
	)
}

runIfScript(import.meta, main)
