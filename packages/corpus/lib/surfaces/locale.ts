/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render real address tuples into locale-specific surface strings.
 *
 *   Public address registers supply inputs such as OA, HM Land Registry and CNIG.
 *   LINZ-derived extracts also supply inputs. The module applies OpenCage templates to
 *   choose ordering and punctuation by country.
 *
 *   Keep the emitted source ids stable: they are persisted in built corpora and referenced by
 *   training configs. `recipes/sources.ts` records each one under its operation spelling
 *   (`rendered-de`) and the `synth-*` spelling it retired on 2026-09-26.
 */

import { formatAddress } from "@mailwoman/codex/address-format"

import type { CanonicalRow } from "#types"

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
	weights. We keep them inline so the output distribution is easy to read. */

/**
 * Real address tuple (for example one OpenAddresses row).
 *
 * Street and locality are required.
 * Other tuple fields are optional.
 */
export interface LocaleBaseTuple {
	house_number?: string
	street: string
	locality: string
	/**
	 * Sub-locality below locality (for example suburb/district).
	 * When present, it is rendered between street and locality.
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
	 * The order used to render the same components.
	 *
	 * `"native"` (default) uses the country's own template (DE → house-after-street, postcode-before-city).
	 * `"international"` renders house-first and postcode-after-city.
	 */
	order?: "native" | "international"
	/**
	 * Postcode surface shape.
	 *
	 * `"conventional"` (default) canonicalizes to the country's rendered form
	 * (NL: OA's glued `1011AB` → the spaced `1011 AB`).
	 * `"as-source"` keeps the source's own surface.
	 *
	 * Today, only NL differs between these modes.
	 */
	postcodeShape?: "conventional" | "as-source"
	/**
	 * How the native-order render joins street and house number.
	 *
	 * The OpenCage ES template comma-joins (`Calle Mayor, 12`, the official Spanish convention).
	 * OA-derived feeds and our ES eval space-join (`calle mayor 12`, the observed form on all 3,000 eval rows).
	 *
	 * `"template"` (default) keeps the template's own join.
	 * `"space"` collapses `<street>, <house_number>` → `<street> <house_number>` after rendering.
	 * International order ignores this.
	 */
	nativeHouseJoin?: "template" | "space"
	/**
	 * The string between rendered address lines.
	 *
	 * `", "` (default) is the template's own join.
	 * `" "` renders the comma-free single-line register for dictation or a copy out of a
	 * one-field form, as in `Neusser Str. 12 Nippes 50733 Köln` for the same components.
	 *
	 * Only native order uses this option.
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
 * NL is the main case: OA may store `1011AB`, while the NL template emits `1011 AB`.
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
 * True when `value` appears verbatim and as a standalone token.
 */
function tokenPresent(raw: string, value: string): boolean {
	if (!raw.includes(value)) return false
	// Reject numeric substring collisions (for example house "2" inside postcode "12623").
	const i = raw.indexOf(value)
	const before = raw[i - 1]
	const after = raw[i + value.length]
	const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"

	if (/^\d+$/.test(value) && (isDigit(before) || isDigit(after))) return false

	return true
}

/**
 * Render one tuple into a locale-ordered `{raw, components}` row via OpenCage templates,
 * with light variation (house number and postcode may be dropped).
 *
 * Returns `null` when the tuple is too thin or a component would not align cleanly.
 *
 * Region handling depends on order:
 * - native omits region for alignment reliability
 * - international includes region in the tail
 *
 * Pass `opts.order: "international"` to render the same components house-first and postcode-after-city
 * instead (see {@link LocaleRenderOpts.order}), matching common feed-style layouts.
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

	// Sub-locality is part of the address body in both orders.
	// If the template does not surface it verbatim, the row is dropped below.
	if (base.dependent_locality) {
		components.dependent_locality = base.dependent_locality
	}

	// The sampler keeps the house number in about 80% of rows.
	// The remaining rows use street-only forms.
	if (base.house_number && random() < 0.8) {
		components.house_number = base.house_number
	}

	// ~85% keep postcode.
	// Canonicalization uses the country's rendered form.
	// `postcodeShape: "as-source"` is applied after rendering.
	if (base.postcode && random() < 0.85) {
		components.postcode = normalizePostcode(base.postcode, country)
	}

	// International order places region in the tail.
	// Native order omits it for alignment.
	if (order === "international" && base.region) {
		components.region = base.region
	}

	// Native order uses the country's template.
	// International order uses the US template.
	// No random draw here, keeping RNG sequence stable.
	const renderCountry = order === "international" ? "US" : country
	const separator = order === "native" ? (opts.separator ?? ", ") : ", "
	let raw = formatAddress(components, renderCountry, { separator })

	if (!raw) return null

	// Optional native-order rewrite: `<street>, <hn>` -> `<street> <hn>`.
	if (order === "native" && separator === ", " && opts.nativeHouseJoin === "space" && components.house_number) {
		raw = raw.replace(
			`${components.street}, ${components.house_number}`,
			`${components.street} ${components.house_number}`
		)
	}

	// `postcodeShape: "as-source"`: rewrite both raw and component to source form.
	// Done post-render because templates may normalize the postcode.
	if (opts.postcodeShape === "as-source" && components.postcode && base.postcode) {
		const sourceForm = base.postcode.trim()

		if (sourceForm && sourceForm !== components.postcode && raw.includes(components.postcode)) {
			raw = raw.replace(components.postcode, sourceForm)
			components.postcode = sourceForm
		}
	}

	// The row is dropped if any component is absent from the rendered address.
	for (const value of Object.values(components)) {
		if (!value || !tokenPresent(raw, value)) return null
	}

	return { raw, components, locale: LOCALE_TAG[country] ?? country.toLowerCase() }
}

/**
 * German wrapper over {@link renderLocaleRow}.
 *
 * Kept for the `german` recipe (`de/recipes/locale.ts`) and tests.
 */
export function renderGermanRow(base: LocaleBaseTuple, opts: LocaleRenderOpts = {}): RenderedLocaleRow | null {
	return renderLocaleRow(base, "DE", opts)
}
