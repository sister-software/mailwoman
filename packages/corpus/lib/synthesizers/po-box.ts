/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Locale-aware PO-box and private-mailbox examples for address training. Standard PO boxes replace
 *   street components; PMB examples retain the street. The full designator and number form the
 *   `po_box` component. Number formatting includes optional OCR-like spacing and punctuation variants.
 */

import { type ComponentDict, formatAddressRow } from "@mailwoman/codex/address-format"
import { countryCodeForTable } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/random"

import { countryToLocale as baseCountryToLocale, tieredNumber } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

/**
 * Minimum digits for thousands-comma formatting.
 */
const MIN_DIGITS_FOR_COMMA_GROUPING = 4

/**
 * Minimum digits for hyphenated formatting.
 */
const MIN_DIGITS_FOR_HYPHEN_GROUPING = 3

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

export interface PoBoxBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

export interface LocaleTemplate {
	locale: string
	leaders: ReadonlyArray<string>
	// Use 'pmb' to render as "street, PMB N, city ..." instead of replacing the street line.
	pmb?: ReadonlyArray<string>
}

/**
 * The per-locale PO-box designator vocabulary (DeepSeek-signed list, see the header).
 *
 * Exported so recipes (the `po-box-cedex` recipe, `recipes/po/box/cedex/recipe.ts`) can reuse
 * this list as the single source of truth for non-US leaders instead of re-deriving it.
 * The US recipe additionally has `@mailwoman/codex/us` `US_PO_BOX_DESIGNATORS`/`isPOBox`
 * as its matcher-side truth.
 */
export const PO_BOX_LOCALE_TEMPLATES: ReadonlyArray<LocaleTemplate> = [
	{
		locale: "en-US",
		leaders: ["PO Box", "P.O. Box", "P.O.Box", "PO BOX", "POB", "Post Office Box", "Box"],
		pmb: ["PMB", "#"],
	},
	{
		locale: "en-CA",
		leaders: ["PO Box", "P.O. Box", "POB", "Post Office Box"],
		pmb: ["PMB", "#"],
	},
	{
		locale: "en-GB",
		leaders: ["PO Box", "P.O. Box", "Post Office Box"],
	},
	{
		locale: "en-AU",
		leaders: ["PO Box", "P.O. Box", "Post Office Box", "GPO Box", "Locked Bag"],
	},
	{
		locale: "en-NZ",
		leaders: ["PO Box", "P.O. Box", "Post Office Box", "Private Bag", "Private Box"],
	},
	{
		locale: "fr-FR",
		leaders: ["BP", "B.P.", "Boîte Postale", "BP."],
	},
	{
		locale: "fr-CA",
		leaders: ["CP", "C.P.", "Case Postale", "BP", "B.P."],
	},
	{
		locale: "es-ES",
		leaders: ["Apdo.", "Apdo", "Apartado", "Apartado de Correos"],
	},
	{
		locale: "es-MX",
		leaders: ["Apdo.", "Apartado", "Apartado Postal", "AP"],
	},
	{
		locale: "es-AR",
		leaders: ["Casilla", "Casilla de Correo", "CC"],
	},
]

const LEADERS_BY_LOCALE = new Map<string, LocaleTemplate>(PO_BOX_LOCALE_TEMPLATES.map((t) => [t.locale, t]))

/**
 * Inject number-format noise into a box number string.
 *
 * @returns The noisy variant or the original (10% probability of noise per the design).
 */
export function maybeNoisifyBoxNumber(num: string, random: () => number): string {
	if (random() > 0.1) return num

	const variants: Array<(s: string) => string> = [
		// Thousands separator.
		(s) => (s.length >= MIN_DIGITS_FOR_COMMA_GROUPING ? `${s.slice(0, -3)},${s.slice(-3)}` : s),
		// Embedded dash.
		(s) => (s.length >= MIN_DIGITS_FOR_HYPHEN_GROUPING ? `${s.slice(0, -2)}-${s.slice(-2)}` : s),
		// Spaces between digits.
		(s) => s.split("").join(" "),
	]

	const f = sample(variants, random)

	return f(num)
}

/**
 * Join a designator and number into one `po_box` phrase.
 */
export function composePoBoxPhrase(leader: string, number: string): string {
	return `${leader} ${number}`
}

export interface SynthesizedPoBoxRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: "po-box" | "pmb-with-street" | "military-po-box"
}

export interface PoBoxSynthesisOpts {
	/**
	 * Random source.
	 * Defaults to `Math.random`.
	 */
	random?: () => number
	/**
	 * Box-number generator.
	 * Defaults to a weighted range from 1 to 99999.
	 */
	pickNumber?: (random: () => number) => string
	/**
	 * PMB probability when the locale and tuple support it.
	 */
	pmbRatio?: number
}

function defaultPickNumber(random: () => number): string {
	// Weight shorter numbers more heavily while retaining long examples.
	return tieredNumber(random, [
		{ cutoff: 0.3, base: 1, span: 99 },
		{ cutoff: 0.7, base: 100, span: 900 },
		{ cutoff: 0.95, base: 1000, span: 9000 },
		{ base: 10_000, span: 90_000 },
	])
}

/**
 * Generate a localized PO-box row, or a PMB row when supported.
 */
export function synthesizePoBoxRow(
	base: PoBoxBaseTuple & { street?: string; houseNumber?: string },
	opts: PoBoxSynthesisOpts = {}
): SynthesizedPoBoxRow | null {
	const random = opts.random ?? Math.random
	const pickNumber = opts.pickNumber ?? defaultPickNumber
	const pmbRatio = opts.pmbRatio ?? 0

	const locale = poBoxTemplateLocale(base.country)
	const tpl = LEADERS_BY_LOCALE.get(locale)

	if (!tpl) return null

	const number = maybeNoisifyBoxNumber(pickNumber(random), random)
	const leader = sample(tpl.leaders, random)
	const poBoxPhrase = composePoBoxPhrase(leader, number)

	// PMB requires a street and a supporting locale.
	const wantPmb = base.street && tpl.pmb && random() < pmbRatio

	// Resolve country names and codes to the layout table's ISO code.
	const iso2 = countryCodeForTable(base.country)

	if (!iso2) return null

	// Let the country's layout determine order and which components are printed.
	const adminTail: ComponentDict = { locality: base.locality, postcode: base.postcode }

	if (base.region?.trim()) {
		adminTail.region = base.region
	}

	if (wantPmb) {
		const pmbLeader = sample(tpl.pmb!, random)
		const pmbPhrase = composePoBoxPhrase(pmbLeader, number)
		const dict: ComponentDict = { ...adminTail, street: base.street!, po_box: pmbPhrase }

		if (base.houseNumber) {
			dict.house_number = base.houseNumber
		}

		const rendered = formatAddressRow(dict, iso2, { singleLine: true })

		if (!rendered) return null

		return {
			raw: rendered.raw,
			components: { ...rendered.components, country: base.country },
			locale,
			template: "pmb-with-street",
		}
	}

	// Standard PO-box rows omit street components.
	const rendered = formatAddressRow({ ...adminTail, po_box: poBoxPhrase }, iso2, { singleLine: true })

	if (!rendered) return null

	return {
		raw: rendered.raw,
		components: { ...rendered.components, country: base.country },
		locale,
		template: "po-box",
	}
}

/**
 * Generate a US military or diplomatic address with a unit line, APO/FPO/DPO locality,
 * armed-forces region, and theatre ZIP.
 */
const MIL_UNITS: ReadonlyArray<{ code: string; boxRequired: boolean }> = [
	{ code: "PSC", boxRequired: true },
	{ code: "CMR", boxRequired: true },
	{ code: "Unit", boxRequired: false },
]

const MIL_PO_CODES = ["APO", "FPO", "DPO"] as const

/**
 * Armed-forces region and corresponding ZIP range.
 */
const MIL_REGION_ZIP: ReadonlyArray<{ region: string; zip: (r: () => number) => string }> = [
	{ region: "AE", zip: (r) => `09${String(Math.floor(r() * 1000)).padStart(3, "0")}` },
	{ region: "AP", zip: (r) => `96${String(200 + Math.floor(r() * 100)).padStart(3, "0")}` },
	{ region: "AA", zip: (r) => `340${String(Math.floor(r() * 100)).padStart(2, "0")}` },
]

/**
 * Generate a military or diplomatic PO-box row without a base tuple.
 */
export function synthesizeMilitaryPoBoxRow(opts: PoBoxSynthesisOpts = {}): SynthesizedPoBoxRow {
	const random = opts.random ?? Math.random
	const unit = sample(MIL_UNITS, random)
	const unitID = String(1 + Math.floor(random() * 9999))
	const { region, zip } = sample(MIL_REGION_ZIP, random)
	const zipStr = zip(random)
	const po = sample(MIL_PO_CODES, random)
	const hasBox = unit.boxRequired || random() < 0.5
	const unitLine = hasBox ? `${unit.code} ${unitID} Box ${1 + Math.floor(random() * 9999)}` : `${unit.code} ${unitID}`
	const raw = `${unitLine}, ${po} ${region} ${zipStr}`

	return {
		raw,
		components: {
			po_box: unitLine,
			locality: po,
			region,
			postcode: zipStr,
			country: "US",
		},
		locale: "en-US",
		template: "military-po-box",
	}
}

const PO_BOX_TEMPLATE_LOCALES: ReadonlySet<string> = new Set(PO_BOX_LOCALE_TEMPLATES.map((t) => t.locale))

/**
 * Return the PO-box vocabulary locale.
 *
 * Unsupported locales use `en-US` vocabulary; address order still comes from the country's layout.
 */
export function poBoxTemplateLocale(country: string): string {
	const locale = baseCountryToLocale(country)

	return PO_BOX_TEMPLATE_LOCALES.has(locale) ? locale : "en-US"
}

/**
 * Locales with PO-box templates.
 */
export function supportedLocales(): ReadonlyArray<string> {
	return PO_BOX_LOCALE_TEMPLATES.map((t) => t.locale)
}

/**
 * Locales whose standard PO-box layout omits the region.
 */
export const REGION_OPTIONAL_LOCALES: ReadonlySet<string> = new Set(["en-NZ"])
