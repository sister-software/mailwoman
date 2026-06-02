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

/** A real address tuple (e.g. one OpenAddresses row): street + locality required, rest optional. */
export interface LocaleBaseTuple {
	house_number?: string
	street: string
	locality: string
	region?: string
	postcode?: string
}
/** @deprecated Alias — use LocaleBaseTuple. */
export type GermanBaseTuple = LocaleBaseTuple

export interface SynthesizedLocaleRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
}
/** @deprecated Alias — use SynthesizedLocaleRow. */
export type SynthesizedGermanRow = SynthesizedLocaleRow

export interface LocaleSynthesisOpts {
	random?: () => number
}
/** @deprecated Alias — use LocaleSynthesisOpts. */
export type GermanSynthesisOpts = LocaleSynthesisOpts

/** ISO-3166 alpha-2 → BCP-47 tag for the emitted rows (primary language per country). */
const LOCALE_TAG: Record<string, string> = {
	DE: "de-DE",
	ES: "es-ES",
	IT: "it-IT",
	NL: "nl-NL",
	GB: "en-GB",
	FR: "fr-FR",
	US: "en-US",
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
 * Render one real tuple into an idiomatic, locale-ordered `{raw, components}` row via the OpenCage
 * `country` template (DE → house-after-street + postcode-before-city; ES/IT the same; GB
 * house-first; NL carries the `1012 LM` postcode), with light variation (drop house number /
 * postcode some of the time). Returns `null` when the tuple is too thin or a component wouldn't
 * align cleanly.
 *
 * Region is intentionally omitted: these templates absorb the admin region into the postcode/city
 * line, so it rarely renders verbatim, and including it would break BIO alignment.
 */
export function synthesizeLocaleRow(
	base: LocaleBaseTuple,
	country: string,
	opts: LocaleSynthesisOpts = {}
): SynthesizedLocaleRow | null {
	const random = opts.random ?? Math.random
	if (!base.street || !base.locality) return null

	const components: CanonicalRow["components"] = { street: base.street, locality: base.locality }
	// ~80% keep the house number (the rest are street-only forms, also idiomatic).
	if (base.house_number && random() < 0.8) components.house_number = base.house_number
	// ~85% keep the postcode.
	if (base.postcode && random() < 0.85) components.postcode = base.postcode

	const raw = formatAddress(components, country, { separator: ", " })
	if (!raw) return null

	// Every component must align — drop the row if the template didn't surface one verbatim, or a
	// numeric component collides with a neighbouring digit run.
	for (const value of Object.values(components)) {
		if (!value || !tokenPresent(raw, value)) return null
	}

	return { raw, components, locale: LOCALE_TAG[country] ?? country.toLowerCase() }
}

/** German wrapper over {@link synthesizeLocaleRow}. Kept for the build-german-shard caller + tests. */
export function synthesizeGermanRow(
	base: LocaleBaseTuple,
	opts: LocaleSynthesisOpts = {}
): SynthesizedLocaleRow | null {
	return synthesizeLocaleRow(base, "DE", opts)
}
