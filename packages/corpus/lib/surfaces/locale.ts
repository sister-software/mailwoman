/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Renders a real address tuple into the surface its locale writes. First introduced for German
 *   coverage (night-shift 2026-06-02, DE-1), now shared by country-oriented recipes.
 *
 *   IT RENDERS RATHER THAN INVENTS, and the directory name says so because the old one did not.
 *   Every caller supplies tuples from a published register: OpenAddresses Berlin and Saxony for DE,
 *   HM Land Registry Price Paid Data for GB, OpenAddresses countrywide for NL and IT, the CNIG
 *   export for ES, a LINZ-derived extract for NZ. What this file composes is the ORDER and the
 *   punctuation, through the OpenCage template for the country.
 *
 *   This lived under `synthesizers/` until 2026-09-22, beside the recipes that do invent a surface
 *   to teach a form — `po-box.ts`, `intersection.ts`, `boundary-stress.ts`, `no-street.ts`. A reader
 *   took the directory at its word and published twice that GB's street rows were fabricated, when
 *   they are 25,674,049 Land Registry addresses sampled to 800,000. The two kinds of recipe now sit
 *   in two directories.
 *
 *   The `synth-*` source ids the recipes emit are unchanged and stay unchanged. A source id is a
 *   wire identifier: it is stored on every row of every built corpus and addressed by the
 *   `source_weights` keys of 225 training configs, so renaming one breaks loading a corpus that
 *   already exists. `docs/engineering/reference/locale-supply.mdx` states what each `synth-` id
 *   reads.
 *
 *   The neural model is out-of-distribution on German: it truncates `Straußstraße`→`Strau` (exits at
 *   the ß-piece boundary), absorbs the house number into the street (`Hauptstraße 5` → one span),
 *   and mis-tags the native-order house number as a postcode (`Prenzlauer Allee 36, 10405 Berlin` →
 *   postcode `36`). The cause is order: the model was trained US+FR (house-number-first,
 *   postcode-after-city), and never saw the German convention (house-number-after-street,
 *   postcode-before-city). DE-0 confirmed the tokenizer round-trips German orthography cleanly, so
 *   this is a coverage gap rather than a tokenizer ceiling.
 *
 *   The original German generator produced the missing signal as a small targeted supplement source
 *   (synthesis-as-supplement discipline: weight < 0.25, one-and-done). It does not synthesize
 *   German street names (German morphology is hard to fake) — it takes real German component tuples
 *   (from OpenAddresses Berlin/Saxony) and renders them in idiomatic German order via the OpenCage
 *   `DE` template (`formatAddress(..., "DE")` → `"Straußstraße 27, 12623 Berlin"`). The corpus
 *   aligner turns the row into BIO labels. every emitted component surface form occurs verbatim in
 *   `raw` so alignment lands. Its locale-neutral API now also serves the international recipe.
 */

import { formatAddress } from "@mailwoman/codex/address-format"

import type { CanonicalRow } from "#types"

/**
 * A real address tuple (e.g. One OpenAddresses row): street + locality required, rest optional.
 */
/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

export interface LocaleBaseTuple {
	house_number?: string
	street: string
	locality: string
	/**
	 * A sub-locality that sits below the locality (a suburb / district).
	 *
	 * NZ is the case that needs it: the OA district column holds the city (`Auckland`)
	 * and city holds the suburb (`Birkenhead`), so the real envelope carries
	 * both (`31 Rawene Road, Birkenhead, Auckland`).
	 * Rendered between street and locality in both orders when present.
	 */
	dependent_locality?: string
	region?: string
	postcode?: string
}

/**
 * @deprecated Alias — use LocaleBaseTuple.
 */
export type GermanBaseTuple = LocaleBaseTuple

export interface RenderedLocaleRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
}

/**
 * @deprecated Alias — use RenderedLocaleRow.
 */
export type RenderedGermanRow = RenderedLocaleRow

export interface LocaleRenderOpts {
	random?: () => number
	/**
	 * Rendering order for the same components.
	 *
	 * `"native"` (default) uses the country's own template (DE → house-after-street, postcode-before-city).
	 * `"international"` renders house-first, postcode-after-city — the US/GB layout that international
	 * feeds, US-centric systems, and our own OpenAddresses de-sample impose on non-US addresses.
	 *
	 * Training both teaches the model that a German address can arrive either way,
	 * so the eval's US-order rendering stops reading as a collapse.
	 * See `docs/articles/evals/resolver-geo/2026-06-06-anchor-pilot.md` (the order-artifact correction).
	 */
	order?: "native" | "international"
	/**
	 * Postcode surface shape.
	 *
	 * `"conventional"` (default) canonicalizes to the country's rendered form
	 * (NL: OA's glued `1011AB` → the spaced `1011 AB`); `"as-source"` keeps the source's own surface.
	 * The form OA (and the OA-derived evals) feed, which for NL is 100% glued.
	 *
	 * Only NL differs today.
	 * Every other country passes through identically either way.
	 *
	 * Mixing both teaches the two-letter-suffix `1012 LM` shape and the glued feed shape
	 * (#241 — the model currently glues the suffix onto the city).
	 */
	postcodeShape?: "conventional" | "as-source"
	/**
	 * How the native-order render joins street and house number.
	 *
	 * The OpenCage ES template comma-joins (`Calle Mayor, 12` — the official Spanish convention); OA-derived
	 * feeds and our ES eval space-join (`calle mayor 12`, the observed form on all 3,000 eval rows).
	 * `"template"` (default) keeps the template's own join; `"space"` collapses
	 * `<street>, <house_number>` → `<street> <house_number>` after rendering.
	 *
	 * Countries whose template already space-joins (DE/IT/NL) render identically under both.
	 * Mixing both stops an ES recipe output from teaching the comma as the street→house
	 * boundary signal (#241 format-diversity audit).
	 *
	 * International order ignores this (the US template is already house-first space-joined).
	 */
	nativeHouseJoin?: "template" | "space"
	/**
	 * The string between rendered address lines.
	 *
	 * `", "` (default) is the template's own join.
	 * `" "` renders the comma-free single-line register — dictation, a copy out of a
	 * one-field form — `Neusser Str. 12 Nippes 50733 Köln` for the same components.
	 *
	 * Stage 2 segments the comma form into three and the comma-free form into one, and a single segment
	 * starves the placetype-pair prior, which is how the comma-free form loses `Nippes` (#1946).
	 * Only the native order reads it.
	 * The international layout keeps its own separator.
	 */
	separator?: ", " | " "
}

/**
 * @deprecated Alias — use LocaleRenderOpts.
 */
export type GermanRenderOpts = LocaleRenderOpts

/**
 * ISO-3166 alpha-2 → BCP-47 tag for the emitted rows (primary language per country).
 */
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
 * Canonicalize a postcode to the form the country's template renders,
 * so the stored component aligns verbatim against `raw`.
 *
 * NL is the case that needs it: OA stores `1011AB` but the OpenCage NL template
 * emits the conventional spaced `1011 AB` (4 digits + space + 2 letters),
 * which otherwise fails verbatim alignment and drops the row.
 * Other countries pass through unchanged.
 */
function normalizePostcode(postcode: string, country: string): string {
	if (country === "NL") {
		const m = /^(\d{4})\s*([A-Za-z]{2})$/.exec(postcode)

		if (m) return `${m[1]} ${m[2]!.toUpperCase()}`
	}

	return postcode
}

/**
 * True when `value` appears verbatim and as a standalone token (so BIO alignment lands cleanly).
 */
function tokenPresent(raw: string, value: string): boolean {
	if (!raw.includes(value)) return false
	// Reject substring-of-a-larger-number collisions (e.g. House "2" inside postcode "12623").
	const i = raw.indexOf(value)
	const before = raw[i - 1]
	const after = raw[i + value.length]
	const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"

	if (/^\d+$/.test(value) && (isDigit(before) || isDigit(after))) return false

	return true
}

/**
 * Render one real tuple into an idiomatic, locale-ordered `{raw, components}` row via
 * the OpenCage `country` template (DE → house-after-street + postcode-before-city.
 * ES/IT the same. GB house-first. NL carries the `1012 LM` postcode), with light
 * variation (drop house number / postcode some of the time).
 *
 * Returns `null` when the tuple is too thin or a component wouldn't align cleanly.
 *
 * Region handling is order-dependent: native order omits it
 * (the native template absorbs the admin region into the postcode/city line, so it rarely
 * renders verbatim and would break BIO alignment), while international order includes it
 * in the tail ("City, Region Postcode" — the US/feed layout the eval uses. v0.9.3 / #327).
 *
 * Pass `opts.order: "international"` to render the same components house-first / postcode-after-city
 * instead (see {@link LocaleRenderOpts.order}) — the layout international feeds impose on
 * foreign addresses, and the one a native-order-trained model treats as a "collapse."
 */
export function renderLocaleRow(
	base: LocaleBaseTuple,
	country: string,
	opts: LocaleRenderOpts = {}
): RenderedLocaleRow | null {
	const random = opts.random ?? Math.random
	const order = opts.order ?? "native"

	if (!base.street || !base.locality) return null

	const components: CanonicalRow["components"] = { street: base.street, locality: base.locality }

	// Sub-locality (suburb / district) sits between street and locality and renders in both orders.
	// It's part of the address body rather than the admin-region tail that native order drops.
	// NZ needs it (suburb + city both on the envelope).
	// The tokenPresent check below drops the row if the template didn't surface it verbatim.
	if (base.dependent_locality) {
		components.dependent_locality = base.dependent_locality
	}

	// ~80% keep the house number (the rest are street-only forms, also idiomatic).
	if (base.house_number && random() < 0.8) {
		components.house_number = base.house_number
	}

	// ~85% keep the postcode (canonicalized to the country's rendered form — NL spaces it).
	// The `postcodeShape: "as-source"` rewrite happens after the render: the OpenCage NL template
	// normalizes the postcode itself, so a glued input can't survive rendering directly.
	if (base.postcode && random() < 0.85) {
		components.postcode = normalizePostcode(base.postcode, country)
	}

	// International order carries the region in the tail ("City, Region Postcode").
	// The layout real US/feed renderings (and our OA eval) use. v0.9.2 rendered international
	// order without the region, so the model never learned to segment the tail and mangled it at
	// eval (region absorbed into the locality / locality dropped); v0.9.3 closes that gap (#327).
	// Native order still drops the region (the native template absorbs it into the
	// city line, which would break verbatim alignment).
	if (order === "international" && base.region) {
		components.region = base.region
	}

	// Native order uses the address's own country template.
	// International order uses the US template — house-first, postcode-after-city,
	// with a region slot for the tail.
	// Neither branch consumes a `random()` draw for the template, so the RNG sequence
	// existing callers/tests depend on is stable.
	const renderCountry = order === "international" ? "US" : country
	const separator = order === "native" ? (opts.separator ?? ", ") : ", "
	let raw = formatAddress(components, renderCountry, { separator })

	if (!raw) return null

	// Native-order space-join (see {@link LocaleRenderOpts.nativeHouseJoin}):
	// collapse the template's `<street>, <hn>` comma to a space — the OA/feed layout.
	// A no-op for templates that already space-join (the substring isn't present),
	// and skipped when the house number was dropped above.
	if (order === "native" && separator === ", " && opts.nativeHouseJoin === "space" && components.house_number) {
		raw = raw.replace(
			`${components.street}, ${components.house_number}`,
			`${components.street} ${components.house_number}`
		)
	}

	// `postcodeShape: "as-source"` (see {@link LocaleRenderOpts.postcodeShape}): rewrite both raw
	// and the component back to the source's own surface (NL glued `1011AB`).
	// Post-render because the OpenCage NL template normalizes the postcode to the
	// spaced form no matter what it's given.
	if (opts.postcodeShape === "as-source" && components.postcode && base.postcode) {
		const sourceForm = base.postcode.trim()

		if (sourceForm && sourceForm !== components.postcode && raw.includes(components.postcode)) {
			raw = raw.replace(components.postcode, sourceForm)
			components.postcode = sourceForm
		}
	}

	// Every component must align — drop the row if the template didn't surface one verbatim,
	// or a numeric component collides with a neighbouring digit run.
	for (const value of Object.values(components)) {
		if (!value || !tokenPresent(raw, value)) return null
	}

	return { raw, components, locale: LOCALE_TAG[country] ?? country.toLowerCase() }
}

/**
 * German wrapper over {@link renderLocaleRow}.
 *
 * Kept for the `german` recipe (`de/recipes/locale.ts`) + tests.
 */
export function renderGermanRow(base: LocaleBaseTuple, opts: LocaleRenderOpts = {}): RenderedLocaleRow | null {
	return renderLocaleRow(base, "DE", opts)
}
