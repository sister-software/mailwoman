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

/** Matches a `{{{slot}}}` mustache reference, tolerant of internal whitespace. */
function slotPattern(slot: string): RegExp {
	return new RegExp(`\\{\\{\\{\\s*${slot}\\s*\\}\\}\\}`)
}

/**
 * `true` if `template` references `{{{slot}}}` OUTSIDE of any `{{#first}}...{{/first}}` block. A slot named inside a
 * `{{#first}}` alternation (Fragaria's Mustache lambda that renders every alternative then keeps only the first
 * non-empty one, joined by `||`) is not an independently-renderable line — it only surfaces when every alternative
 * ahead of it in the chain is empty. Several "neither slot" templates reference `quarter`/`suburb`-adjacent tags
 * (`village`, `hamlet`, `place`) purely as fallback alternatives for `city` or `road`, which are always populated by
 * this formatter — so those references never actually render and are unsafe to target.
 */
function hasStandaloneSlot(template: string, slot: string): boolean {
	if (!slotPattern(slot).test(template)) return false

	const firstBlockPattern = /\{\{#first\}\}([\s\S]*?)\{\{\/first\}\}/g
	let strippedTemplate = template
	let match: RegExpExecArray | null

	while ((match = firstBlockPattern.exec(template))) {
		strippedTemplate = strippedTemplate.replace(match[0], "")
	}

	return slotPattern(slot).test(strippedTemplate)
}

/**
 * Derived, at module load, from the vendored template data (`@fragaria/address-formatter/src/templates/templates.json`)
 * — never a hardcoded country list. Classifies every real 2-letter country code's primary `address_template` by how (if
 * at all) it can render a sub-locality/`dependent_locality` value:
 *
 * - `quarterOnly` — renders `{{{quarter}}}` but not `{{{suburb}}}` (GB and friends — see
 *   `.superpowers/sdd/task-4-report.md` / `task-4a-report.md`). `dependent_locality` is mirrored onto `quarter`.
 * - `placeOnly` — references NEITHER `{{{suburb}}}` NOR `{{{quarter}}}`, but DOES carry a standalone `{{{place}}}` line
 *   (not buried inside a `{{#first}}` alternation with `road`/`city`, where it would never render — see
 *   `hasStandaloneSlot`). FR's lieu-dit is the confirmed case: `{{{place}}}` sits on its own line, exactly where French
 *   postal convention (La Poste's line 5, "Lieu-dit") puts it — directly above the postcode+town line.
 *   `dependent_locality` is mirrored onto `place`.
 * - `postRender` — references NEITHER slot AND has no standalone `place` line either (ES's pedanía is the confirmed case
 *   — its template's only `place`/`village`/`hamlet` references are folded into the `{{#first}}` alternation for
 *   `city`, which `city` itself always wins). These countries get `formatAddress`'s post-render line-injection fallback
 *   (see `injectDependentLocalityLine`) — there is no template-native slot to target.
 *
 * `dependent_locality` is mapped to `suburb` unconditionally in `toOpenCageComponents` regardless of this
 * classification (that's what NZ and the ~66 other "suburb-only" templates read directly); `BR` references BOTH
 * `suburb` and `quarter` for two distinct concepts and is excluded from all three sets by construction (its template
 * already renders `dependent_locality` via the unconditional `suburb` mapping — mirroring onto `quarter` too would
 * double-render the same value on two lines).
 */
const DEPENDENT_LOCALITY_SLOTS: {
	quarterOnly: ReadonlySet<string>
	placeOnly: ReadonlySet<string>
	postRender: ReadonlySet<string>
} = (() => {
	const quarterOnly = new Set<string>()
	const placeOnly = new Set<string>()
	const postRender = new Set<string>()
	const templates = fragariaTemplates as Record<string, { address_template?: string }>

	for (const [code, def] of Object.entries(templates)) {
		// Restrict to real 2-letter country codes — the template data also carries language-variant
		// pseudo-keys (`CA_en`, `CA_fr`, `JP_ja`, …) that aren't selected by country_code lookup.
		if (!/^[A-Z]{2}$/.test(code)) continue

		const template = def.address_template

		if (!template) continue

		const hasQuarter = slotPattern("quarter").test(template)
		const hasSuburb = slotPattern("suburb").test(template)

		if (hasQuarter && !hasSuburb) {
			quarterOnly.add(code)
		} else if (!hasQuarter && !hasSuburb) {
			if (hasStandaloneSlot(template, "place")) {
				placeOnly.add(code)
			} else {
				postRender.add(code)
			}
		}
	}

	return { quarterOnly, placeOnly, postRender }
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

	let raw = addressFormatter.format(ocComponents, {
		abbreviate: opts.abbreviate ?? false,
		appendCountry: opts.appendCountry ?? false,
	})

	// Last-resort path (see DEPENDENT_LOCALITY_SLOTS.postRender): ES's pedanía and its siblings have no
	// template-native slot at all — the primary template never surfaces `suburb`/`quarter`/`place`. Splice the
	// value in as its own line, positioned the way OpenCage's own fallback templates already do it for these
	// same countries (a dedicated sub-locality line directly above the postcode+city line).
	if (components.dependent_locality && DEPENDENT_LOCALITY_SLOTS.postRender.has(country.trim().toUpperCase())) {
		raw = injectDependentLocalityLine(raw, components.locality, components.dependent_locality)
	}

	const trimmed = raw.replace(/\s+$/g, "")

	return opts.separator !== undefined ? trimmed.replace(/\n+/g, opts.separator) : trimmed
}

/**
 * Splice `dependentLocality` in as its own line immediately above the line carrying `locality` (a case-insensitive
 * substring match against that line only — not the whole rendered string, which would misfire on incidental substring
 * collisions elsewhere in the address). Used by `formatAddress` for the `DEPENDENT_LOCALITY_SLOTS.postRender` fallback,
 * where no template slot exists to target directly.
 *
 * Idempotent: if `raw` already carries a line that IS `dependentLocality` verbatim (case/whitespace-insensitive), no
 * second line is inserted. If `locality` is missing or doesn't appear on any line of `raw`, there's no safe anchor to
 * splice against, so `raw` is returned unchanged (matches the pre-fix behavior of silently dropping the value, rather
 * than guessing a position).
 *
 * Exported for testing.
 */
export function injectDependentLocalityLine(
	raw: string,
	locality: string | undefined,
	dependentLocality: string
): string {
	const lines = raw.split("\n")
	const normalizedDepLoc = dependentLocality.trim().toLowerCase()

	if (lines.some((line) => line.trim().toLowerCase() === normalizedDepLoc)) {
		return raw
	}

	if (!locality) return raw

	const normalizedLocality = locality.trim().toLowerCase()
	// LAST match, not first: a street line can legitimately embed the locality name too (the "Avenida de
	// <municipio>" class — a street literally named after the town it's in). Anchoring on the first hit
	// then splices the dependent-locality line above the STREET line instead of above the actual
	// locality/postcode line further down. The last match is always the real locality line — nothing
	// renders after it that would also carry the name.
	const anchorIndex = lines.findLastIndex((line) => line.toLowerCase().includes(normalizedLocality))

	if (anchorIndex === -1) return raw

	lines.splice(anchorIndex, 0, dependentLocality)

	return lines.join("\n")
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

		// See DEPENDENT_LOCALITY_SLOTS: some templates (GB among them) name this slot `quarter`
		// instead of `suburb`. Mirroring the value there is additive — `suburb` stays set for every
		// other country's template (NZ included) that reads it directly.
		const depLocCountryCode = country.trim().toUpperCase()

		if (DEPENDENT_LOCALITY_SLOTS.quarterOnly.has(depLocCountryCode)) {
			out.quarter = components.dependent_locality
		} else if (DEPENDENT_LOCALITY_SLOTS.placeOnly.has(depLocCountryCode)) {
			// FR and friends: neither `suburb` nor `quarter` renders, but a standalone `place` line does.
			out.place = components.dependent_locality
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
