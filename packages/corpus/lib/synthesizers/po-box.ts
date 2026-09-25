/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates localized PO-box and private-mailbox rows in which the designator and number form one `po_box` span.
 */

import { type ComponentDict, formatAddressRow } from "@mailwoman/codex/address-format"
import { countryCodeForTable } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/random"

import { countryToLocale as baseCountryToLocale, tieredNumber } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

const MIN_DIGITS_FOR_COMMA_GROUPING = 4

const MIN_DIGITS_FOR_HYPHEN_GROUPING = 3

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

/**
 * The address tail for one PO-box row.
 */
export interface PoBoxBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

/**
 * One locale's PO-box designators.
 */
export interface LocaleTemplate {
	locale: string
	leaders: ReadonlyArray<string>
	/**
	 * Private-mailbox designators, which render beside the street instead of replacing it.
	 */
	pmb?: ReadonlyArray<string>
}

/**
 * The PO-box designator vocabulary for each supported locale.
 *
 * Other recipes, such as the CEDEX recipe, reuse this list.
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
 * Returns the box number unchanged 90% of the time.
 *
 * Otherwise, the function adds a thousands comma, an inner hyphen, or spaces between the digits.
 */
export function maybeNoisifyBoxNumber(num: string, random: () => number): string {
	if (random() > 0.1) return num

	const variants: Array<(s: string) => string> = [
		(s) => (s.length >= MIN_DIGITS_FOR_COMMA_GROUPING ? `${s.slice(0, -3)},${s.slice(-3)}` : s),
		(s) => (s.length >= MIN_DIGITS_FOR_HYPHEN_GROUPING ? `${s.slice(0, -2)}-${s.slice(-2)}` : s),
		(s) => s.split("").join(" "),
	]

	const f = sample(variants, random)

	return f(num)
}

/**
 * Joins a designator and a number into one `po_box` phrase.
 */
export function composePoBoxPhrase(leader: string, number: string): string {
	return `${leader} ${number}`
}

/**
 * One synthesized row with its template.
 */
export interface SynthesizedPoBoxRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: "po-box" | "pmb-with-street" | "military-po-box"
}

/**
 * Options for the PO-box synthesizers.
 */
export interface PoBoxSynthesisOpts {
	/**
	 * The random source, which defaults to `Math.random`.
	 */
	random?: () => number
	/**
	 * The box-number generator, which defaults to a range from 1 to 99,999 weighted toward short numbers.
	 */
	pickNumber?: (random: () => number) => string
	/**
	 * The probability of a private-mailbox row when the locale and tuple allow one.
	 * The default is 0.
	 */
	pmbRatio?: number
}

function defaultPickNumber(random: () => number): string {
	return tieredNumber(random, [
		{ cutoff: 0.3, base: 1, span: 99 },
		{ cutoff: 0.7, base: 100, span: 900 },
		{ cutoff: 0.95, base: 1000, span: 9000 },
		{ base: 10_000, span: 90_000 },
	])
}

/**
 * Generates a localized PO-box row, or a private-mailbox row when the tuple
 * has a street and the locale allows it.
 *
 * The function returns `null` when the country lacks a template locale, an ISO code or a layout.
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

	const wantPmb = base.street && tpl.pmb && random() < pmbRatio

	const iso2 = countryCodeForTable(base.country)

	if (!iso2) return null

	// The country's layout decides the order and which components appear.
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

	const rendered = formatAddressRow({ ...adminTail, po_box: poBoxPhrase }, iso2, { singleLine: true })

	if (!rendered) return null

	return {
		raw: rendered.raw,
		components: { ...rendered.components, country: base.country },
		locale,
		template: "po-box",
	}
}

const MIL_UNITS: ReadonlyArray<{ code: string; boxRequired: boolean }> = [
	{ code: "PSC", boxRequired: true },
	{ code: "CMR", boxRequired: true },
	{ code: "Unit", boxRequired: false },
]

const MIL_PO_CODES = ["APO", "FPO", "DPO"] as const

// Each armed-forces region has its own ZIP range.
const MIL_REGION_ZIP: ReadonlyArray<{ region: string; zip: (r: () => number) => string }> = [
	{ region: "AE", zip: (r) => `09${String(Math.floor(r() * 1000)).padStart(3, "0")}` },
	{ region: "AP", zip: (r) => `96${String(200 + Math.floor(r() * 100)).padStart(3, "0")}` },
	{ region: "AA", zip: (r) => `340${String(Math.floor(r() * 100)).padStart(2, "0")}` },
]

/**
 * Generates a US military or diplomatic address without a base tuple.
 *
 * The unit line is the `po_box`, APO, FPO or DPO is the locality, and the armed-forces code is the region.
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
 * Returns the locale whose PO-box vocabulary a country uses.
 *
 * Countries without their own template use `en-US` designators.
 * Their address order still comes from the country's layout.
 */
export function poBoxTemplateLocale(country: string): string {
	const locale = baseCountryToLocale(country)

	return PO_BOX_TEMPLATE_LOCALES.has(locale) ? locale : "en-US"
}

/**
 * Returns the locales that have PO-box templates.
 */
export function supportedLocales(): ReadonlyArray<string> {
	return PO_BOX_LOCALE_TEMPLATES.map((t) => t.locale)
}

/**
 * Locales whose standard PO-box layout omits the region.
 */
export const REGION_OPTIONAL_LOCALES: ReadonlySet<string> = new Set(["en-NZ"])
