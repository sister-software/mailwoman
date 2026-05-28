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

import type { CanonicalRow } from "./types.js"

export interface PoBoxBaseTuple {
	locality: string
	region: string
	postcode: string
	country: string
}

interface LocaleTemplate {
	locale: string
	leaders: ReadonlyArray<string>
	// Use 'pmb' to render as "STREET, PMB N, CITY ..." instead of replacing the street line.
	pmb?: ReadonlyArray<string>
}

const LOCALE_TEMPLATES: ReadonlyArray<LocaleTemplate> = [
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

const LEADERS_BY_LOCALE = new Map<string, LocaleTemplate>(LOCALE_TEMPLATES.map((t) => [t.locale, t]))

/**
 * Inject number-format noise into a box number string. Returns the noisy variant or the original
 * (10% probability of noise per the design).
 */
export function maybeNoisifyBoxNumber(num: string, random: () => number): string {
	if (random() > 0.1) return num
	const variants: Array<(s: string) => string> = [
		// Thousand-separator comma (real input: "Box 1,234")
		(s) => (s.length >= 4 ? `${s.slice(0, -3)},${s.slice(-3)}` : s),
		// Embedded dash (real input: "PMB-200")
		(s) => (s.length >= 3 ? `${s.slice(0, -2)}-${s.slice(-2)}` : s),
		// Embedded spaces (real input from OCR: "1 2 3 4")
		(s) => s.split("").join(" "),
	]
	const f = variants[Math.floor(random() * variants.length)]!
	return f(num)
}

/**
 * Compose a PO box phrase like "PO Box 123" or "PMB 200".
 *
 * Returns both the phrase and the canonical leader+number so the BIO aligner can mark the entire
 * span as `po_box`.
 */
export function composePoBoxPhrase(leader: string, number: string): string {
	return `${leader} ${number}`
}

export interface SynthesizedPoBoxRow {
	raw: string
	components: CanonicalRow["components"]
	locale: string
	template: "po-box" | "pmb-with-street"
}

export interface PoBoxSynthesisOpts {
	/** Random function — pass deterministic seed for tests. Default Math.random. */
	random?: () => number
	/** Number generator. Default uniform over 1..99999. */
	pickNumber?: (random: () => number) => string
	/** PMB probability when locale supports it (and a street is provided in the base tuple). */
	pmbRatio?: number
}

function defaultPickNumber(random: () => number): string {
	// 70% of real PO boxes are 1-5 digits; long ones exist (USPS allows up to ~6 digits).
	const r = random()
	if (r < 0.3) return String(1 + Math.floor(random() * 99)) // 1-99
	if (r < 0.7) return String(100 + Math.floor(random() * 900)) // 100-999
	if (r < 0.95) return String(1000 + Math.floor(random() * 9000)) // 1000-9999
	return String(10000 + Math.floor(random() * 90000)) // 10000-99999
}

/**
 * Generate one PO box row for a base (locality, region, postcode, country) tuple. Picks a
 * locale-appropriate leader and number. Optionally generates a PMB variant when the base tuple
 * includes a street.
 */
export function synthesizePoBoxRow(
	base: PoBoxBaseTuple & { street?: string; houseNumber?: string },
	opts: PoBoxSynthesisOpts = {}
): SynthesizedPoBoxRow | null {
	const random = opts.random ?? Math.random
	const pickNumber = opts.pickNumber ?? defaultPickNumber
	const pmbRatio = opts.pmbRatio ?? 0.0

	const locale = countryToLocale(base.country)
	const tpl = LEADERS_BY_LOCALE.get(locale)
	if (!tpl) return null

	const number = maybeNoisifyBoxNumber(pickNumber(random), random)
	const leader = tpl.leaders[Math.floor(random() * tpl.leaders.length)]!
	const poBoxPhrase = composePoBoxPhrase(leader, number)

	// PMB variant: requires both a street and a PMB-supporting locale.
	const wantPmb = base.street && tpl.pmb && random() < pmbRatio
	if (wantPmb) {
		const pmbLeader = tpl.pmb![Math.floor(random() * tpl.pmb!.length)]!
		const pmbPhrase = composePoBoxPhrase(pmbLeader, number)
		const streetLine = base.houseNumber ? `${base.houseNumber} ${base.street}` : base.street!
		const raw = `${streetLine}, ${pmbPhrase}, ${base.locality}, ${base.region} ${base.postcode}`
		return {
			raw,
			components: {
				...(base.houseNumber ? { house_number: base.houseNumber } : {}),
				street: base.street!,
				po_box: pmbPhrase,
				locality: base.locality,
				region: base.region,
				postcode: base.postcode,
				country: base.country,
			},
			locale,
			template: "pmb-with-street",
		}
	}

	// Standard PO box: replaces the street line entirely.
	const raw = `${poBoxPhrase}, ${base.locality}, ${base.region} ${base.postcode}`
	return {
		raw,
		components: {
			po_box: poBoxPhrase,
			locality: base.locality,
			region: base.region,
			postcode: base.postcode,
			country: base.country,
		},
		locale,
		template: "po-box",
	}
}

/**
 * Map a country code (ISO-3166-1 alpha-2 or alpha-3, or country display name) to the locale code we
 * have a PO box template for.
 */
export function countryToLocale(country: string): string {
	const c = country.trim().toUpperCase()
	if (c === "US" || c === "USA" || c === "UNITED STATES") return "en-US"
	if (c === "CA" || c === "CAN" || c === "CANADA") return "en-CA"
	if (c === "GB" || c === "UK" || c === "GBR" || c === "UNITED KINGDOM") return "en-GB"
	if (c === "AU" || c === "AUS" || c === "AUSTRALIA") return "en-AU"
	if (c === "FR" || c === "FRA" || c === "FRANCE") return "fr-FR"
	if (c === "ES" || c === "ESP" || c === "SPAIN") return "es-ES"
	if (c === "MX" || c === "MEX" || c === "MEXICO") return "es-MX"
	if (c === "AR" || c === "ARG" || c === "ARGENTINA") return "es-AR"
	return "en-US"
}

/** All locales we synthesize for. Exposed for tests and for source-weight tuning. */
export function supportedLocales(): ReadonlyArray<string> {
	return LOCALE_TEMPLATES.map((t) => t.locale)
}
