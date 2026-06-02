/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   German address synthesizer — multi-locale coverage (night-shift 2026-06-02, DE-1).
 *
 *   The neural model is out-of-distribution on German: it truncates `Straußstraße`→`Strau` (exits at
 *   the ß-piece boundary), absorbs the house number into the street (`Hauptstraße 5` → one span),
 *   and mis-tags the native-order house number as a postcode (`Prenzlauer Allee 36, 10405 Berlin` →
 *   postcode `36`). The cause is ORDER: the model was trained US+FR (house-number-FIRST,
 *   postcode-AFTER-city), and never saw the German convention (house-number-AFTER-street,
 *   postcode-BEFORE-city). DE-0 confirmed the tokenizer round-trips German orthography cleanly, so
 *   this is a coverage gap, not a tokenizer ceiling.
 *
 *   This generator produces the missing signal as a small targeted supplement shard
 *   (synthesis-as-supplement discipline: weight < 0.25, one-and-done). It does NOT synthesize
 *   German street names (German morphology is hard to fake) — it takes REAL German component tuples
 *   (from OpenAddresses Berlin/Saxony) and renders them in idiomatic German order via the OpenCage
 *   `DE` template (`formatAddress(..., "DE")` → `"Straußstraße 27, 12623 Berlin"`). The corpus
 *   aligner turns the row into BIO labels; every emitted component surface form occurs verbatim in
 *   `raw` so alignment lands.
 */

import { formatAddress } from "./format.js"
import type { CanonicalRow } from "./types.js"

/** A real German address tuple (e.g. one OpenAddresses Berlin/Saxony row). */
export interface GermanBaseTuple {
	house_number?: string
	street: string
	locality: string
	region?: string
	postcode?: string
}

export interface SynthesizedGermanRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
}

export interface GermanSynthesisOpts {
	random?: () => number
}

/** True when `value` appears verbatim AND as a standalone token (so BIO alignment lands cleanly). */
function tokenPresent(raw: string, value: string): boolean {
	if (!raw.includes(value)) return false
	// Reject substring-of-a-larger-number collisions (e.g. house "2" inside postcode "12623").
	const i = raw.indexOf(value)
	const before = raw[i - 1]
	const after = raw[i + value.length]
	const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"
	if (/^\d+$/.test(value) && (isDigit(before) || isDigit(after))) return false
	return true
}

/**
 * Render one real German tuple into an idiomatic German-order `{raw, components}` row, with light
 * variation (drop house number / postcode some of the time) so the model sees both full and partial
 * German addresses. Returns `null` when the tuple is too thin or a component wouldn't align
 * cleanly.
 *
 * Region is intentionally omitted: the German template absorbs the Bundesland into the
 * postcode/city line, so it rarely renders verbatim — including it would break alignment.
 */
export function synthesizeGermanRow(
	base: GermanBaseTuple,
	opts: GermanSynthesisOpts = {}
): SynthesizedGermanRow | null {
	const random = opts.random ?? Math.random
	if (!base.street || !base.locality) return null

	const components: CanonicalRow["components"] = { street: base.street, locality: base.locality }
	// ~80% keep the house number (the rest are street-only "Straße, Stadt" forms, also idiomatic).
	if (base.house_number && random() < 0.8) components.house_number = base.house_number
	// ~85% keep the postcode (German postcodes lead the city line: "12623 Berlin").
	if (base.postcode && random() < 0.85) components.postcode = base.postcode

	const raw = formatAddress(components, "DE", { separator: ", " })
	if (!raw) return null

	// Every component must align — drop the row if the template didn't surface one verbatim, or a
	// numeric component collides with a neighbouring digit run.
	for (const value of Object.values(components)) {
		if (!value || !tokenPresent(raw, value)) return null
	}

	return { raw, components, locale: "de-DE" }
}
