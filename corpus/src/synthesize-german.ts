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

import { formatAddress } from "./format.ts"
import type { CanonicalRow } from "./types.ts"

/** A real address tuple (e.g. one OpenAddresses row): street + locality required, rest optional. */
export interface LocaleBaseTuple {
	house_number?: string
	street: string
	locality: string
	/**
	 * A sub-locality that sits BELOW the locality (a suburb / district). NZ is the case that needs it: the OA DISTRICT
	 * column holds the city (`Auckland`) and CITY holds the suburb (`Birkenhead`), so the real envelope carries both (`31
	 * Rawene Road, Birkenhead, Auckland`). Rendered between street and locality in both orders when present.
	 */
	dependent_locality?: string
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
	/**
	 * Rendering order for the SAME components. `"native"` (default) uses the country's own template (DE →
	 * house-AFTER-street, postcode-BEFORE-city). `"international"` renders house-FIRST, postcode-AFTER-city — the US/GB
	 * layout that international feeds, US-centric systems, and our own OpenAddresses de-sample impose on non-US
	 * addresses. Training both teaches the model that a German address can arrive either way, so the eval's US-order
	 * rendering stops reading as a collapse. See `docs/articles/evals/resolver-geo/2026-06-06-anchor-pilot.md` (the
	 * order-artifact correction).
	 */
	order?: "native" | "international"
	/**
	 * Postcode surface shape. `"conventional"` (default) canonicalizes to the country's rendered form (NL: OA's glued
	 * `1011AB` → the spaced `1011 AB`); `"as-source"` keeps the source's own surface — the form OA (and the OA-derived
	 * evals) feed, which for NL is 100% glued. Only NL differs today; every other country passes through identically
	 * either way. Mixing both teaches the two-letter-suffix `1012 LM` shape AND the glued feed shape (#241 — the model
	 * currently glues the suffix onto the city).
	 */
	postcodeShape?: "conventional" | "as-source"
	/**
	 * How the NATIVE-order render joins street and house number. The OpenCage ES template comma-joins (`Calle Mayor, 12`
	 * — the official Spanish convention); OA-derived feeds and our ES eval space-join (`CALLE MAYOR 12`, the observed
	 * form on all 3,000 eval rows). `"template"` (default) keeps the template's own join; `"space"` collapses `<street>,
	 * <house_number>` → `<street> <house_number>` after rendering. Countries whose template already space-joins
	 * (DE/IT/NL) render identically under both. Mixing both stops an ES shard from teaching the comma as THE street→house
	 * boundary signal (#241 format-diversity audit). International order ignores this (the US template is already
	 * house-first space-joined).
	 */
	nativeHouseJoin?: "template" | "space"
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
	NZ: "en-NZ",
}

/**
 * Canonicalize a postcode to the form the country's template renders, so the stored component aligns verbatim against
 * `raw`. NL is the case that needs it: OA stores `1011AB` but the OpenCage NL template emits the conventional spaced
 * `1011 AB` (4 digits + space + 2 letters), which otherwise fails verbatim alignment and drops the row. Other countries
 * pass through unchanged.
 */
function normalizePostcode(postcode: string, country: string): string {
	if (country === "NL") {
		const m = /^(\d{4})\s*([A-Za-z]{2})$/.exec(postcode)

		if (m) return `${m[1]} ${m[2]!.toUpperCase()}`
	}

	return postcode
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
 * Render one real tuple into an idiomatic, locale-ordered `{raw, components}` row via the OpenCage `country` template
 * (DE → house-after-street + postcode-before-city; ES/IT the same; GB house-first; NL carries the `1012 LM` postcode),
 * with light variation (drop house number / postcode some of the time). Returns `null` when the tuple is too thin or a
 * component wouldn't align cleanly.
 *
 * Region handling is order-dependent: NATIVE order omits it (the native template absorbs the admin region into the
 * postcode/city line, so it rarely renders verbatim and would break BIO alignment), while INTERNATIONAL order includes
 * it in the tail ("City, Region Postcode" — the US/feed layout the eval uses; v0.9.3 / #327).
 *
 * Pass `opts.order: "international"` to render the same components house-first / postcode-after-city instead (see
 * {@link LocaleSynthesisOpts.order}) — the layout international feeds impose on foreign addresses, and the one a
 * native-order-trained model treats as a "collapse."
 */
export function synthesizeLocaleRow(
	base: LocaleBaseTuple,
	country: string,
	opts: LocaleSynthesisOpts = {}
): SynthesizedLocaleRow | null {
	const random = opts.random ?? Math.random
	const order = opts.order ?? "native"

	if (!base.street || !base.locality) return null

	const components: CanonicalRow["components"] = { street: base.street, locality: base.locality }

	// Sub-locality (suburb / district) sits between street and locality and renders in BOTH orders — it's part
	// of the address body, not the admin-region tail that native order drops. NZ needs it (suburb + city both on
	// the envelope). The tokenPresent gate below drops the row if the template didn't surface it verbatim.
	if (base.dependent_locality) {
		components.dependent_locality = base.dependent_locality
	}

	// ~80% keep the house number (the rest are street-only forms, also idiomatic).
	if (base.house_number && random() < 0.8) {
		components.house_number = base.house_number
	}

	// ~85% keep the postcode (canonicalized to the country's rendered form — NL spaces it). The
	// `postcodeShape: "as-source"` rewrite happens AFTER the render: the OpenCage NL template
	// normalizes the postcode itself, so a glued input can't survive rendering directly.
	if (base.postcode && random() < 0.85) {
		components.postcode = normalizePostcode(base.postcode, country)
	}

	// International order carries the REGION in the tail ("City, Region Postcode") — the layout real
	// US/feed renderings (and our OA eval) use. v0.9.2 rendered international order WITHOUT the region,
	// so the model never learned to segment the tail and mangled it at eval (region absorbed into the
	// locality / locality dropped); v0.9.3 closes that gap (#327). Native order still drops the region
	// (the native template absorbs it into the city line, which would break verbatim alignment).
	if (order === "international" && base.region) {
		components.region = base.region
	}

	// Native order uses the address's own country template; international order uses the US template —
	// house-first, postcode-after-city, with a region slot for the tail. Neither branch consumes a
	// `random()` draw for the template, so the RNG sequence existing callers/tests depend on is stable.
	const renderCountry = order === "international" ? "US" : country
	let raw = formatAddress(components, renderCountry, { separator: ", " })

	if (!raw) return null

	// Native-order space-join (see {@link LocaleSynthesisOpts.nativeHouseJoin}): collapse the template's
	// `<street>, <hn>` comma to a space — the OA/feed layout. A no-op for templates that already
	// space-join (the substring isn't present), and skipped when the house number was dropped above.
	if (order === "native" && opts.nativeHouseJoin === "space" && components.house_number) {
		raw = raw.replace(
			`${components.street}, ${components.house_number}`,
			`${components.street} ${components.house_number}`
		)
	}

	// `postcodeShape: "as-source"` (see {@link LocaleSynthesisOpts.postcodeShape}): rewrite BOTH raw and
	// the component back to the source's own surface (NL glued `1011AB`). Post-render because the
	// OpenCage NL template normalizes the postcode to the spaced form no matter what it's given.
	if (opts.postcodeShape === "as-source" && components.postcode && base.postcode) {
		const sourceForm = base.postcode.trim()

		if (sourceForm && sourceForm !== components.postcode && raw.includes(components.postcode)) {
			raw = raw.replace(components.postcode, sourceForm)
			components.postcode = sourceForm
		}
	}

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
