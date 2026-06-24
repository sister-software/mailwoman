/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Anchor-absorption counter-augmentation (#220/#723, Probe A1). Teaches the model the CONTEXT-
 *   DEPENDENT leading-5-digit disambiguation that the killed #723 override was faking, AND that the
 *   `anchor_paint_mode=shaped` WHERE fix alone over-corrected on (Probe A0: it flipped the default to
 *   house_number, recovering CASE-H but ERODING CASE-P — postcode F1 99.3→86.5 on leading-postcode
 *   rows like "05764 Finel Hollow Road, VT").
 *
 *   THE DISCRIMINATOR the model must learn (from the CASE-H vs CASE-P contrast, NOT a flipped default):
 *     - a leading 5-digit WITH a trailing postcode + street context  → it is the HOUSE NUMBER (CASE-H)
 *     - a leading 5-digit with NO trailing postcode (US-rural / DE)   → it IS the POSTCODE   (CASE-P)
 *   Both leading tokens are real ZIPs (so the painted anchor fires on both); only the surrounding
 *   context separates them. The model attends to the trailing token to decide the leading one.
 *
 *   Slice mix (the A0 learning sets a HEAVY CASE-P floor so the default doesn't flip — DeepSeek's
 *   ≥35% CASE-P; here CASE-P total = 35%):
 *     H-adversarial   30%  US street, leading real-ZIP house# + TRAILING postcode → house_number
 *     P-us-rural      20%  US rural, leading postcode, NO trailing → postcode   (the A0-erosion fix)
 *     P-de            15%  German leading postcode "{pc} {city}, {street} {hn}" → postcode
 *     anchor-fp       10%  leading 5-digit that is NOT a real ZIP + trailing postcode → house_number
 *     locale-ambig    15%  minimal context; the local token (street-type vs none) decides
 *     standard        10%  normal small house# + trailing postcode → house_number (baseline)
 *
 *   Real ZIPs for the leading-5-digit are sampled from the postcode anchor lookup at build time
 *   (passed via opts.realZips) so the shaped anchor fires on them exactly as at inference; fake ZIPs
 *   (anchor-fp) are 5-digit strings deliberately absent from the lookup.
 */

import type { ComponentTag } from "@mailwoman/core/types"

export interface AnchorAbsorptionBaseTuple {
	locality: string
	region: string
	postcode: string
}

export type AnchorAbsorptionTemplate = "h-adversarial" | "p-us-rural" | "p-de" | "anchor-fp" | "locale-ambig" | "standard"

export interface AnchorAbsorptionSynthesisOpts {
	random?: () => number
	forceTemplate?: AnchorAbsorptionTemplate
	/** Real US ZIPs (in the anchor lookup) to use as the LEADING 5-digit house number — so the painted
	 * anchor fires on it, the CASE-H/anchor-fp trigger. Builder loads these from pilot-anchor-lookup.json. */
	realZips?: ReadonlyArray<string>
}

export interface SynthesizedAnchorAbsorptionRow {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	locale: string
	template: AnchorAbsorptionTemplate
}

function pick<T>(arr: ReadonlyArray<T>, random: () => number): T {
	return arr[Math.floor(random() * arr.length)]!
}

// Curated, provenance-light reference vocab (real US street/city/state + DE). Surface forms must appear
// in `raw` for alignRow; these are plain ASCII tokens that align cleanly.
const STREET_NAMES = [
	"Main", "Oak", "Elm", "Maple", "Cedar", "Pine", "Washington", "Lincoln", "Park", "Hill",
	"Finel Hollow", "Mt Tabor", "Swasey", "Camperdown", "Mellville", "Rhone", "Westpark", "Crescent Meadow",
]
const STREET_TYPES = ["St", "Ave", "Rd", "Dr", "Ln", "Blvd", "Ct", "Way", "Road", "Drive"]
const US_TUPLES: ReadonlyArray<AnchorAbsorptionBaseTuple> = [
	{ locality: "Springfield", region: "IL", postcode: "62701" },
	{ locality: "Portland", region: "OR", postcode: "97215" },
	{ locality: "Houston", region: "TX", postcode: "77598" },
	{ locality: "Dallas", region: "TX", postcode: "75229" },
	{ locality: "Austin", region: "TX", postcode: "78748" },
	{ locality: "Albuquerque", region: "NM", postcode: "87102" },
	{ locality: "Rochester", region: "NY", postcode: "14606" },
	{ locality: "Sacramento", region: "CA", postcode: "95823" },
]
// US rural states where the leading-postcode "{ZIP} {Street}, {STATE}" form (no trailing ZIP) is real —
// the VT/rural format the #723 override broke and Probe A0 eroded.
const RURAL_REGIONS = ["VT", "ND", "SD", "NH", "ME", "MT", "WY"]
// DE leading-postcode tuples: "{postcode} {locality}, {street} {house}".
const DE_TUPLES = [
	{ postcode: "10115", locality: "Berlin", street: "Hauptstraße" },
	{ postcode: "80331", locality: "München", street: "Sendlinger Straße" },
	{ postcode: "20095", locality: "Hamburg", street: "Mönckebergstraße" },
	{ postcode: "50667", locality: "Köln", street: "Hohe Straße" },
	{ postcode: "01067", locality: "Dresden", street: "Prager Straße" },
]
const HOUSE_NUMS = ["5", "12", "27", "100", "212", "1450", "8"]
// Fake 5-digit strings that are NOT real US ZIPs (so the anchor lookup MISSES them) — for anchor-fp.
const FAKE_ZIPS = ["00000", "99998", "99997", "00001", "99996"]

/** Build one anchor-absorption counter-augmentation row. */
export function synthesizeAnchorAbsorptionRow(
	opts: AnchorAbsorptionSynthesisOpts = {}
): SynthesizedAnchorAbsorptionRow {
	const random = opts.random ?? Math.random
	const realZips = opts.realZips && opts.realZips.length ? opts.realZips : US_TUPLES.map((t) => t.postcode)
	const template = opts.forceTemplate ?? pick(ALL_TEMPLATES, random)
	const street = `${pick(STREET_NAMES, random)} ${pick(STREET_TYPES, random)}`

	if (template === "h-adversarial") {
		// US street, leading real-ZIP house number, WITH a trailing postcode → the leading is house_number.
		const zip = pick(realZips, random)
		const t = pick(US_TUPLES, random)
		const raw = `${zip} ${street}, ${t.locality}, ${t.region} ${t.postcode}`
		return {
			raw,
			components: { house_number: zip, street, locality: t.locality, region: t.region, postcode: t.postcode },
			locale: "en-US",
			template,
		}
	}
	if (template === "p-us-rural") {
		// US rural, leading postcode, NO trailing postcode → the leading IS the postcode (the A0-erosion fix).
		const zip = pick(realZips, random)
		const region = pick(RURAL_REGIONS, random)
		const raw = `${zip} ${street}, ${region}`
		return {
			raw,
			components: { postcode: zip, street, region },
			locale: "en-US",
			template,
		}
	}
	if (template === "p-de") {
		// German leading postcode "{pc} {city}, {street} {hn}" → the leading is the postcode.
		const d = pick(DE_TUPLES, random)
		const hn = pick(HOUSE_NUMS, random)
		const raw = `${d.postcode} ${d.locality}, ${d.street} ${hn}`
		return {
			raw,
			components: { postcode: d.postcode, locality: d.locality, street: d.street, house_number: hn },
			locale: "de-DE",
			template,
		}
	}
	if (template === "anchor-fp") {
		// Leading 5-digit that is NOT a real ZIP (anchor MISSES) + trailing postcode → still house_number.
		const fake = pick(FAKE_ZIPS, random)
		const t = pick(US_TUPLES, random)
		const raw = `${fake} ${street}, ${t.locality}, ${t.region} ${t.postcode}`
		return {
			raw,
			components: { house_number: fake, street, locality: t.locality, region: t.region, postcode: t.postcode },
			locale: "en-US",
			template,
		}
	}
	if (template === "locale-ambig") {
		// Minimal context — the LOCAL token decides. Half: "{realZip} {street}" (street-type → house#);
		// half: "{realZip} {locality}" (no street, leading postcode → postcode). No trailing, no region.
		const zip = pick(realZips, random)
		if (random() < 0.5) {
			return { raw: `${zip} ${street}`, components: { house_number: zip, street }, locale: "en-US", template }
		}
		const t = pick(US_TUPLES, random)
		return { raw: `${zip} ${t.locality}`, components: { postcode: zip, locality: t.locality }, locale: "en-US", template }
	}
	// standard: normal small house number + trailing postcode → house_number (baseline, keeps the common case).
	const hn = pick(HOUSE_NUMS, random)
	const t = pick(US_TUPLES, random)
	const raw = `${hn} ${street}, ${t.locality}, ${t.region} ${t.postcode}`
	return {
		raw,
		components: { house_number: hn, street, locality: t.locality, region: t.region, postcode: t.postcode },
		locale: "en-US",
		template,
	}
}

// Weighted template bag — the slice mix (CASE-P total 35%, H-adversarial 30%). Expanded to a flat array
// so `pick` draws at the target frequencies (matches the boundary-stress ALL_TEMPLATES idiom).
export const ALL_TEMPLATES: ReadonlyArray<AnchorAbsorptionTemplate> = [
	...Array<AnchorAbsorptionTemplate>(30).fill("h-adversarial"),
	...Array<AnchorAbsorptionTemplate>(20).fill("p-us-rural"),
	...Array<AnchorAbsorptionTemplate>(15).fill("p-de"),
	...Array<AnchorAbsorptionTemplate>(10).fill("anchor-fp"),
	...Array<AnchorAbsorptionTemplate>(15).fill("locale-ambig"),
	...Array<AnchorAbsorptionTemplate>(10).fill("standard"),
]
