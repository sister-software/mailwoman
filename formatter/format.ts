/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Render a `ComponentTag`-keyed dict into a country-localized string — the inverse of the parser.
 *
 *   This is the canonical home for Mailwoman's address formatting, consolidated from two earlier
 *   half-implementations: the `core/formatter` stub (which wrapped OpenCage but hardcoded `US`) and
 *   the corpus synthesis formatter (`corpus/src/format.ts`, the fuller one this is ported from).
 *
 *   It bridges Mailwoman's `ComponentTag` schema to OpenCage's `address-formatting` templates
 *   (vendored via `@fragaria/address-formatter`, MIT) so callers get idiomatic per-country output
 *   without reinventing template logic. Owning our own templates — so we can express the slots
 *   OpenCage can't (`unit`, `intersection`, `cedex`, the JP tags) — is a deliberate follow-up; this
 *   first cut keeps Fragaria as the engine and concentrates the mapping in one place.
 *
 *   Known limitations inherited from the OpenCage vocabulary (documented, not blockers):
 *
 *   - `unit`: no slot, so units ride the road line (`"Pennsylvania Ave NW Apt 4B"`).
 *   - `intersection_a` / `intersection_b`: joined as `"<a> & <b>"` into the road field.
 *   - `cedex` (FR): folded into `postcode` (`"75008 CEDEX 08"`) so the FR template slots it right.
 *   - JP-specific tags (`prefecture`, `municipality`, …): no mapping yet.
 */

import addressFormatter from "@fragaria/address-formatter"
import fragariaTemplates from "@fragaria/address-formatter/src/templates/templates.json" with { type: "json" }
import type { ClassificationMap, VisibleClassification } from "@mailwoman/core/types"
import type { ComponentTag } from "@mailwoman/core/types"

/**
 * Country codes whose vendored OpenCage `address_template` renders the sub-locality slot as `{{{quarter}}}` and does
 * NOT also reference `{{{suburb}}}` — derived from the vendored template data itself
 * (`@fragaria/address-formatter/src/templates/templates.json`), not a hardcoded country list. `dependent_locality` is
 * mapped to `suburb` unconditionally below (that's what NZ's template reads, and most templates that carry a
 * sub-locality slot use `suburb`); for the countries in this set, `suburb` is a dead fallback slot the primary template
 * never reaches (GB is the one that surfaced this — see `.superpowers/sdd/task-4-report.md`), so we additionally mirror
 * the value onto `quarter` so it actually renders.
 *
 * One country (`BR`) references BOTH `suburb` and `quarter` in its primary template for two distinct concepts (a
 * finer-grained "quarter" line above the neighbourhood line) — it's deliberately excluded from this set so
 * `dependent_locality` doesn't double-render there.
 */
const QUARTER_ONLY_COUNTRY_CODES: ReadonlySet<string> = (() => {
	const codes = new Set<string>()
	const templates = fragariaTemplates as Record<string, { address_template?: string }>

	for (const [code, def] of Object.entries(templates)) {
		// Restrict to real 2-letter country codes — the template data also carries language-variant
		// pseudo-keys (`CA_en`, `CA_fr`, `JP_ja`, …) that aren't selected by country_code lookup.
		if (!/^[A-Z]{2}$/.test(code)) continue

		const template = def.address_template

		if (!template) continue

		const hasQuarter = /\{\{\{\s*quarter\s*\}\}\}/.test(template)
		const hasSuburb = /\{\{\{\s*suburb\s*\}\}\}/.test(template)

		if (hasQuarter && !hasSuburb) {
			codes.add(code)
		}
	}

	return codes
})()

/** A partial map of `ComponentTag` → string value — the canonical formatter input. */
export type ComponentDict = Partial<Record<ComponentTag, string>>

/** Options accepted by `formatAddress`. */
export interface FormatAddressOptions {
	/**
	 * Append the country name as a final line (`"USA"`, `"France"`). Default `false`: most rows are intra-country and the
	 * country line is redundant noise.
	 */
	appendCountry?: boolean

	/**
	 * Apply OpenCage's per-country abbreviation rules (`"Avenue"` → `"Ave"`). Default `false` — callers that want
	 * abbreviation usually run it as their own augmentation pass.
	 */
	abbreviate?: boolean

	/**
	 * Replace the template's newlines with this separator. Default `undefined` (keep newlines). Use `", "` for
	 * single-line output, or `" "` to strip internal punctuation.
	 */
	separator?: string
}

/**
 * Render a component dict into an idiomatic per-country address string.
 *
 * Returns an empty string if `components` is empty after translation. Throws nothing — bad inputs degrade to the
 * longest meaningful prefix.
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
 * Map of legacy rule-classifier {@linkcode VisibleClassification} labels to the canonical `ComponentTag` schema. The
 * two vocabularies are kept independent on purpose (rule classifiers emit one, the neural classifier the other); this
 * adapter is the bridge so a `ClassificationMap` can use the same formatter. `level` / `unit_designator` /
 * `level_designator` are folded into `unit`.
 */
const CLASSIFICATION_TO_TAG: Partial<Record<VisibleClassification, ComponentTag>> = {
	country: "country",
	region: "region",
	locality: "locality",
	dependency: "dependent_locality",
	postcode: "postcode",
	house_number: "house_number",
	street: "street",
	venue: "venue",
}

/**
 * Format a legacy {@linkcode ClassificationMap} (`Map<VisibleClassification, string[]>`, as emitted by the rule-based
 * pipeline) into an idiomatic address string. Subsumes the former `core/formatter` stub. Multi-span values are
 * space-joined; unit-like labels are merged.
 */
export function formatFromClassificationMap(
	map: ClassificationMap,
	country: string,
	opts: FormatAddressOptions = {}
): string {
	const components: ComponentDict = {}
	const unitParts: string[] = []

	for (const [classification, values] of map) {
		const value = values.filter(Boolean).join(" ").replace(/\s+/g, " ").trim()

		if (!value) continue

		if (classification === "unit" || classification === "level") {
			unitParts.push(value)
			continue
		}

		const tag = CLASSIFICATION_TO_TAG[classification]

		if (tag) {
			components[tag] = value
		}
	}

	if (unitParts.length) {
		components.unit = unitParts.join(" ")
	}

	return formatAddress(components, country, opts)
}

/**
 * Drop any component whose value isn't actually present in the formatted `raw`. OpenCage's per-country templates
 * legitimately omit some inputs (FR regions absorbed by the postcode; US state names abbreviated), and downstream
 * alignment requires `components[tag]` to occur in `raw`. Comparison is case- and whitespace-insensitive; the retained
 * value is the original input.
 */
export function reconcileComponents(components: ComponentDict, raw: string): ComponentDict {
	const haystack = raw.toLowerCase().replace(/\s+/g, " ")
	const out: ComponentDict = {}

	for (const [k, v] of Object.entries(components)) {
		if (!v) continue
		const needle = v.toLowerCase().replace(/\s+/g, " ")

		if (haystack.includes(needle)) {
			out[k as ComponentTag] = v
		}
	}

	return out
}

/**
 * Translate a `ComponentTag` dict to the OpenCage vocabulary `@fragaria/address-formatter` expects. Exported for
 * testing and for callers that pre-build the dict for batch formatting.
 */
export function toOpenCageComponents(components: ComponentDict, country: string): Record<string, string> {
	const out: Record<string, string> = {}

	const road = composeRoad(components)

	if (road) {
		out.road = road
	}

	if (components.house_number) {
		out.house_number = components.house_number
	}

	if (components.venue) {
		out.house = components.venue
	}

	if (components.locality) {
		out.city = components.locality
	}

	if (components.dependent_locality) {
		out.suburb = components.dependent_locality

		// See QUARTER_ONLY_COUNTRY_CODES: some templates (GB among them) name this slot `quarter`
		// instead of `suburb`. Mirroring the value there is additive — `suburb` stays set for every
		// other country's template (NZ included) that reads it directly.
		if (QUARTER_ONLY_COUNTRY_CODES.has(country.trim().toUpperCase())) {
			out.quarter = components.dependent_locality
		}
	}

	if (components.subregion) {
		out.county = components.subregion
	}

	if (components.region) {
		out.state = components.region
	}

	const postcode = composePostcode(components)

	if (postcode) {
		out.postcode = postcode
	}

	if (components.po_box) {
		out.po_box = components.po_box
	}

	if (components.attention) {
		out.attention = components.attention
	}

	if (components.country) {
		out.country = components.country
	}

	// country_code drives template selection, not output. Only emit it alongside another component —
	// otherwise the template renders the bare code ("US") as a fallback line, which no caller wants.
	const cc = country.trim().toLowerCase()

	if (cc && Object.keys(out).length > 0) {
		out.country_code = cc
	}

	return out
}

/**
 * Build the `road` line from prefix / particle / street / suffix / unit / intersection components:
 *
 *     ;[intersection_a & intersection_b]
 *     OR[street_prefix][street_prefix_particle][street][street_suffix][unit]
 */
function composeRoad(components: ComponentDict): string {
	if (components.intersection_a && components.intersection_b) {
		return `${components.intersection_a} & ${components.intersection_b}`
	}

	const parts: string[] = []

	if (components.street_prefix) {
		parts.push(components.street_prefix)
	}

	if (components.street_prefix_particle) {
		parts.push(components.street_prefix_particle)
	}

	if (components.street) {
		parts.push(components.street)
	}

	if (components.street_suffix) {
		parts.push(components.street_suffix)
	}

	if (components.unit) {
		parts.push(components.unit)
	}

	return parts.join(" ").replace(/\s+/g, " ").trim()
}

/**
 * Fold CEDEX into postcode for FR-style output: `"75008"` + `"CEDEX 08"` → `"75008 CEDEX 08"`. If only one is present,
 * return it; if neither, return empty.
 */
function composePostcode(components: ComponentDict): string {
	const base = components.postcode?.trim() ?? ""
	const cedex = components.cedex?.trim() ?? ""

	if (base && cedex) return `${base} ${cedex}`.replace(/\s+/g, " ")

	return base || cedex
}
