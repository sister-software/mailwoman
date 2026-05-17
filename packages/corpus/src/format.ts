/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a `ComponentTag`-keyed dict into a country-localized string.
 *
 *   Phase 1's adapters carry ground-truth components but need a plausible `raw` string for the model
 *   to learn from. This module bridges Mailwoman's `ComponentTag` schema to OpenCage's
 *   `address-formatting` templates (vendored via `@fragaria/address-formatter`, MIT) so adapters
 *   can synthesize idiomatic per-country output without each one reinventing the template logic.
 *
 *   `@fragaria/address-formatter` returns multi-line strings (newline-separated). This module honors
 *   that by default and exposes a `separator` option to coerce to single-line when an adapter wants
 *   `", "` joined output for the corpus.
 *
 *   Limitations (documented, not blockers for Phase 1):
 *
 *   - `unit`: OpenCage's vocabulary doesn't have a slot, so units are appended to the road line
 *       (`"Pennsylvania Ave NW Apt 4B"`). Phase 2 or beyond can change this if needed.
 *   - `intersection_a` / `intersection_b`: joined as `"<a> & <b>"` into the road field.
 *   - `cedex` (FR): folded into `postcode` (e.g. `"75008 CEDEX 08"`) so the FR template renders it in
 *       the right slot.
 *   - JP-specific tags (`prefecture`, `municipality`, ...): no mapping yet — left for Phase 6 when JP
 *       becomes a live locale.
 */

import addressFormatter from "@fragaria/address-formatter"
import type { ComponentTag } from "@mailwoman/core/types"

/** Options accepted by `formatAddress`. */
export interface FormatAddressOptions {
	/**
	 * Append the country name as a final line (`"USA"`, `"France"`). Default `false`: most corpus
	 * rows are intra-country and the country prefix is redundant noise.
	 */
	appendCountry?: boolean

	/**
	 * Apply OpenCage's per-country abbreviation rules (e.g. `"Avenue"` → `"Ave"`, `"Boulevard"` →
	 * `"Blvd"`). Default `false`. Phase 1 prefers unabbreviated output because synthesis
	 * (`synthesize.ts`) handles abbreviation swaps as its own augmentation pass.
	 */
	abbreviate?: boolean

	/**
	 * Replace the template's newlines with this separator. Default `undefined` (keep newlines). Use
	 * `", "` to get a single-line output, or `" "` to remove all internal punctuation.
	 */
	separator?: string
}

type ComponentDict = Partial<Record<ComponentTag, string>>

/**
 * Render a component dict into an idiomatic per-country address string.
 *
 * Returns an empty string if `components` is empty after translation. Throws nothing — bad inputs
 * (empty dict, unsupported tag) silently degrade to the longest meaningful prefix.
 */
export function formatAddress(components: ComponentDict, country: string, opts: FormatAddressOptions = {}): string {
	const ocComponents = toOpenCageComponents(components, country)
	if (Object.keys(ocComponents).length === 0) return ""

	const raw = addressFormatter.format(ocComponents, {
		abbreviate: opts.abbreviate ?? false,
		appendCountry: opts.appendCountry ?? false,
	})

	const trimmed = raw.replace(/\s+$/g, "")
	return opts.separator !== undefined ? trimmed.replace(/\n+/g, opts.separator) : trimmed
}

/**
 * Translate a `ComponentTag` dict to the OpenCage vocabulary that `@fragaria/address-formatter`
 * expects. Exported for testing and for adapters that want to pre-build the dict for batch
 * formatting.
 */
export function toOpenCageComponents(components: ComponentDict, country: string): Record<string, string> {
	const out: Record<string, string> = {}

	const road = composeRoad(components)
	if (road) out.road = road

	if (components.house_number) out.house_number = components.house_number

	if (components.venue) out.house = components.venue

	if (components.locality) out.city = components.locality
	if (components.dependent_locality) out.suburb = components.dependent_locality
	if (components.subregion) out.county = components.subregion
	if (components.region) out.state = components.region

	const postcode = composePostcode(components)
	if (postcode) out.postcode = postcode

	if (components.po_box) out.po_box = components.po_box
	if (components.attention) out.attention = components.attention

	if (components.country) out.country = components.country

	// country_code drives template selection, not output. Only emit it if at least one other
	// component is present — otherwise the FR/US templates render the bare code as a fallback
	// line ("US"), which is never what a corpus consumer wants.
	const cc = country.trim().toLowerCase()
	if (cc && Object.keys(out).length > 0) out.country_code = cc

	return out
}

/**
 * Build the `road` line from prefix / particle / street / suffix / unit / intersection components.
 * Order:
 *
 * ```
 * [intersection_a & intersection_b]
 * OR
 * [street_prefix] [street_prefix_particle] [street] [street_suffix] [unit]
 * ```
 */
function composeRoad(components: ComponentDict): string {
	if (components.intersection_a && components.intersection_b) {
		return `${components.intersection_a} & ${components.intersection_b}`
	}

	const parts: string[] = []
	if (components.street_prefix) parts.push(components.street_prefix)
	if (components.street_prefix_particle) parts.push(components.street_prefix_particle)
	if (components.street) parts.push(components.street)
	if (components.street_suffix) parts.push(components.street_suffix)
	if (components.unit) parts.push(components.unit)

	return parts.join(" ").replace(/\s+/g, " ").trim()
}

/**
 * Fold CEDEX into postcode for FR-style output: `"75008"` + cedex `"CEDEX 08"` → `"75008 CEDEX
 * 08"`. If only one is present, return it. If neither, return empty.
 */
function composePostcode(components: ComponentDict): string {
	const base = components.postcode?.trim() ?? ""
	const cedex = components.cedex?.trim() ?? ""
	if (base && cedex) return `${base} ${cedex}`.replace(/\s+/g, " ")
	return base || cedex
}
