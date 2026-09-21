/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PO box / PMB / Apartado / Boîte Postale synthesizer.
 *
 *   Generates BIO-labeled corpus rows where the delivery line is a PO box (mutually exclusive with
 *   street + house_number per USPS Pub 28 / DMM 508). Locale-aware: emits idiomatic forms for
 *   en-US, en-CA, en-GB, en-AU, fr-FR, fr-CA, es-ES, es-MX, es-AR.
 *
 *   Per-DeepSeek design:
 *
 *   - PMB ("Private Mailbox" — at CMRAs like UPS Store) shares the `po_box` tag with USPS PO Box.
 *       Disambiguation is a downstream heuristic (presence of a street line).
 *   - Whole-phrase span ("PO Box 123") not number-only ("123"). Matches existing golden eval.
 *   - 10% of outputs receive number-format noise (commas, dashes, embedded spaces) to harden against
 *       real-world OCR/transcription input.
 *   - PO boxes drop street/house_number/unit/street_prefix/street_suffix from input components.
 *
 *   References:
 *
 *   - USPS Pub 28 §28C2.040 — Private Mailbox formatting
 *   - USPS DMM 508 §4.1.4 / §4.5.4 — PO Box and street-addressed PO Box
 */

import { type ComponentDict, formatAddressRow } from "@mailwoman/codex/address-format"
import { countryCodeForTable } from "@mailwoman/codex/country"
import { sample } from "@mailwoman/core/random"

import { countryToLocale as baseCountryToLocale, tieredNumber } from "#synthesizers/utils"
import type { CanonicalRow } from "#types"

/**
 * Digits a box number needs before a thousands comma is plausible (`1,234`).
 */
const MIN_DIGITS_FOR_COMMA_GROUPING = 4

/**
 * Digits a box number needs before a hyphen group is plausible (`12-34`).
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
 * Exported so recipes (the `po-box-cedex` recipe, `recipes/po/box/cedex/recipe.ts`)
 * can reuse this list as the single source of truth for non-US leaders
 * instead of re-deriving it — the US recipe additionally has `@mailwoman/codex/us`
 * `US_PO_BOX_DESIGNATORS`/`isPOBox` as its matcher-side truth.
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
 * Inject number-format noise into a box number string. Returns the noisy variant
 * or the original (10% probability of noise per the design).
 */
export function maybeNoisifyBoxNumber(num: string, random: () => number): string {
	if (random() > 0.1) return num

	const variants: Array<(s: string) => string> = [
		// Thousand-separator comma (real input: "Box 1,234")
		(s) => (s.length >= MIN_DIGITS_FOR_COMMA_GROUPING ? `${s.slice(0, -3)},${s.slice(-3)}` : s),
		// Embedded dash (real input: "PMB-200")
		(s) => (s.length >= MIN_DIGITS_FOR_HYPHEN_GROUPING ? `${s.slice(0, -2)}-${s.slice(-2)}` : s),
		// Embedded spaces (real input from OCR: "1 2 3 4")
		(s) => s.split("").join(" "),
	]

	const f = sample(variants, random)

	return f(num)
}

/**
 * Compose a PO box phrase like "PO Box 123" or "PMB 200".
 *
 * Returns both the phrase and the canonical leader+number so the BIO aligner
 * can mark the entire span as `po_box`.
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
	 * Random function — pass deterministic seed for tests. Default Math.random.
	 */
	random?: () => number
	/**
	 * Number generator. Default uniform over 1..99999.
	 */
	pickNumber?: (random: () => number) => string
	/**
	 * PMB probability when locale supports it (and a street is provided in the base tuple).
	 */
	pmbRatio?: number
}

function defaultPickNumber(random: () => number): string {
	// 70% of real PO boxes are 1-5 digits. long ones exist (USPS allows up to ~6 digits).
	// Bands: 1-99, 100-999, 1000-9999, 10000-99999 (span 90_000 — the street generator's 89_999 is its own).
	return tieredNumber(random, [
		{ cutoff: 0.3, base: 1, span: 99 },
		{ cutoff: 0.7, base: 100, span: 900 },
		{ cutoff: 0.95, base: 1000, span: 9000 },
		{ base: 10_000, span: 90_000 },
	])
}

/**
 * Generate one PO box row for a base (locality, region, postcode, country) tuple.
 * Picks a locale-appropriate leader and number. Optionally generates a PMB variant
 * when the base tuple includes a street.
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

	// PMB variant: requires both a street and a PMB-supporting locale.
	const wantPmb = base.street && tpl.pmb && random() < pmbRatio

	// A tuple's `country` is whatever its source wrote — `ES`, `ESP` or `Spain` — and a layout is
	// keyed by the alpha-2 code. Resolving here rather than requiring the code of every caller
	// keeps the same breadth `poBoxTemplateLocale` already accepts for the box vocabulary.
	const iso2 = countryCodeForTable(base.country)

	if (!iso2) return null

	// The country's own layout writes the order and the separators, and reports
	// which components it printed — France absorbs the region into its postcode line,
	// so a row that emitted `region` regardless would carry a label whose text is not in `raw`.
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

	// A PO box replaces the street line entirely.
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
 * The US military/diplomatic PO-box class (#517). A distinct shape the leader-based locale templates
 * can't express: a unit line (`PSC <id> Box <box>`, `CMR <id> Box <box>`, `Unit <id> [Box <box>]`)
 * tagged `po_box`, then the post-office code (APO/FPO/DPO) as the locality
 * and the armed-forces region (AA/AE/AP) as the region, with a theatre-specific ZIP.
 * Authoritative reference + citations: `@mailwoman/codex` `codex/us/military-address.ts`;
 * the small constants are inlined here so the generator is self-contained.
 */
const MIL_UNITS: ReadonlyArray<{ code: string; boxRequired: boolean }> = [
	{ code: "PSC", boxRequired: true },
	{ code: "CMR", boxRequired: true },
	{ code: "Unit", boxRequired: false },
]

const MIL_PO_CODES = ["APO", "FPO", "DPO"] as const

/**
 * Region → plausible ZIP prefix (AE Europe 09xxx, AP Pacific 962-966xx, AA Americas 340xx).
 */
const MIL_REGION_ZIP: ReadonlyArray<{ region: string; zip: (r: () => number) => string }> = [
	{ region: "AE", zip: (r) => `09${String(Math.floor(r() * 1000)).padStart(3, "0")}` },
	{ region: "AP", zip: (r) => `96${String(200 + Math.floor(r() * 100)).padStart(3, "0")}` },
	{ region: "AA", zip: (r) => `340${String(Math.floor(r() * 100)).padStart(2, "0")}` },
]

/**
 * Generate one US military/diplomatic PO-box row (#517).
 * Self-contained — draws no base tuple.
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
 * The locale whose PO-BOX vocabulary a country's rows are written in — which is a narrower question
 * than `countryToLocale`'s, and the reason this carries its own name rather than shadowing it.
 *
 * A locale the shared map resolves but {@link PO_BOX_LOCALE_TEMPLATES} does not carry falls back
 * to `en-US`, so `DE` (shared: `de-DE`, no PO-box template) renders the en-US box vocabulary.
 * The order is a separate axis and comes from the country's own codex layout,
 * so such a row is German-ordered with American box words.
 */
export function poBoxTemplateLocale(country: string): string {
	const locale = baseCountryToLocale(country)

	return PO_BOX_TEMPLATE_LOCALES.has(locale) ? locale : "en-US"
}

/**
 * All locales we synthesize for. Exposed for tests and for source-weight tuning.
 */
export function supportedLocales(): ReadonlyArray<string> {
	return PO_BOX_LOCALE_TEMPLATES.map((t) => t.locale)
}

/**
 * Locales whose standard PO-box delivery line carries no region token — the address reads `<po_box>, <locality>
 * <postcode>` with nothing between locality and postcode (#517). NZ is the canonical case (`Private Bag 12, Auckland
 * 1010`). Consumers (e.g. the synth-po-box adapter) use this to avoid discarding region-less input tuples for these
 * locales as "missing region".
 */
export const REGION_OPTIONAL_LOCALES: ReadonlySet<string> = new Set(["en-NZ"])
