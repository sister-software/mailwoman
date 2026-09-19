/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Anchor-absorption counter-augmentation (#220/#723, Probe A1). Teaches the model the context-
 *   dependent leading-5-digit disambiguation that the killed #723 override was faking, and that the
 *   `anchor_paint_mode=shaped` where fix alone over-corrected on (Probe A0: it flipped the default
 *   to house_number, recovering case-H but eroding case-P — postcode F1 99.3→86.5 on
 *   leading-postcode rows like "05764 Finel Hollow Road, VT").
 *
 *   The discriminator the model must learn (from the case-H vs case-P contrast rather than a flipped
 *   default):
 *
 *   - A leading 5-digit with a trailing postcode + street context → it is the house number (case-H)
 *   - A leading 5-digit with no trailing postcode (US-rural / DE) → it is the postcode (case-P) Both
 *       leading tokens are real ZIPs (so the painted anchor fires on both); only the surrounding
 *       context separates them. The model attends to the trailing token to decide the leading one.
 *
 *   Template mix (the A0 learning sets a heavy case-P floor so the default doesn't flip — DeepSeek's
 *   ≥35% case-P. here case-P total = 35%): H-adversarial 30% US street, leading real-ZIP house# +
 *   trailing postcode → house_number P-us-rural 20% US rural, leading postcode, no trailing →
 *   postcode (the A0-erosion fix) P-de 15% German leading postcode "{pc} {city}, {street} {hn}" →
 *   postcode anchor-fp 10% leading 5-digit that is not a real ZIP + trailing postcode →
 *   house_number locale-ambig 15% minimal context. the local token (street-type vs none) decides
 *   standard 10% normal small house# + trailing postcode → house_number (baseline)
 *
 *   Real ZIPs for the leading-5-digit are sampled from the postcode anchor lookup at build time
 *   (passed via opts.realZips) so the shaped anchor fires on them exactly as at inference. fake
 *   ZIPs (anchor-fp) are 5-digit strings deliberately absent from the lookup.
 */

/* oxlint-disable mailwoman/prefer-home -- the admin tails below are written as US templates because every tuple this
   synthesizer draws from is `US_TUPLES`, a hardcoded US list, and the rows put a bare five-digit ZIP in front of a
   street to make the anchor channel fire on the wrong span. That is a US postcode shape by construction. */

import type { ComponentTag } from "@mailwoman/codex/component"
import { sample } from "@mailwoman/core/random"

/* oxlint-disable sister-software/no-unnamed-threshold -- the bare decimals below are weighted-sampler
   cutoffs rather than thresholds: `const r = random()` followed by a cascade of `r < 0.4` branches is the
   output distribution, and reading the cascade top-to-bottom is how you see it. Naming each cutoff
   would hide the distribution behind a wall of identifiers. Genuine thresholds in these files are
   extracted as named constants above. */

export interface AnchorAbsorptionBaseTuple {
	locality: string
	region: string
	postcode: string
}

export type AnchorAbsorptionTemplate =
	| "h-adversarial"
	| "h-no-trailing-locality"
	| "p-us-rural"
	| "p-de"
	| "anchor-fp"
	| "locale-ambig"
	| "standard"

export interface AnchorAbsorptionSynthesisOpts {
	random?: () => number
	forceTemplate?: AnchorAbsorptionTemplate
	/**
	 * Real US ZIPs (in the anchor lookup) to use as the leading 5-digit house number — so the painted anchor fires on it,
	 * the case-H/anchor-fp trigger. Builder loads these from pilot-anchor-lookup.json.
	 */
	realZips?: ReadonlyArray<string>
}

export interface SynthesizedAnchorAbsorptionRow {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	locale: string
	template: AnchorAbsorptionTemplate
}

/**
 * A realistic US house number: mostly 1–4 digits (the common range), 25% a real 5-digit ZIP (the hard case — a 5-digit
 * leading number that is still a house number when a locality is present).
 */
function houseNum(random: () => number, realZips: ReadonlyArray<string>): string {
	if (random() < 0.25) return sample(realZips, random)

	return String(1 + Math.floor(random() * 9999))
}

/**
 * Curated, provenance-light reference vocab (real US street/city/state + DE). Surface forms must appear in `raw` for
 * alignRow. these are plain ascii tokens that align cleanly.
 */
const STREET_NAMES = [
	"Main",
	"Oak",
	"Elm",
	"Maple",
	"Cedar",
	"Pine",
	"Washington",
	"Lincoln",
	"Park",
	"Hill",
	"Finel Hollow",
	"Mt Tabor",
	"Swasey",
	"Camperdown",
	"Mellville",
	"Rhone",
	"Westpark",
	"Crescent Meadow",
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

/**
 * US rural states where the leading-postcode "{ZIP} {Street}, {state}" form (no trailing ZIP) is real — the VT/rural
 * format the #723 override broke and Probe A0 eroded.
 */
const RURAL_REGIONS = ["VT", "ND", "SD", "NH", "ME", "MT", "WY"]

/**
 * DE leading-postcode tuples: "{postcode} {locality}, {street} {house}".
 */
const DE_TUPLES = [
	{ postcode: "10115", locality: "Berlin", street: "Hauptstraße" },
	{ postcode: "80331", locality: "München", street: "Sendlinger Straße" },
	{ postcode: "20095", locality: "Hamburg", street: "Mönckebergstraße" },
	{ postcode: "50667", locality: "Köln", street: "Hohe Straße" },
	{ postcode: "01067", locality: "Dresden", street: "Prager Straße" },
]

const HOUSE_NUMS = ["5", "12", "27", "100", "212", "1450", "8"]
/**
 * Fake 5-digit strings that are not real US ZIPs (so the anchor lookup misses them) — for anchor-fp.
 */
const FAKE_ZIPS = ["00000", "99998", "99997", "00001", "99996"]

/**
 * Build one anchor-absorption counter-augmentation row.
 */
export function synthesizeAnchorAbsorptionRow(
	opts: AnchorAbsorptionSynthesisOpts = {}
): SynthesizedAnchorAbsorptionRow {
	const random = opts.random ?? Math.random
	const realZips = opts.realZips && opts.realZips.length ? opts.realZips : US_TUPLES.map((t) => t.postcode)
	const template = opts.forceTemplate ?? sample(ALL_TEMPLATES, random)
	const street = `${sample(STREET_NAMES, random)} ${sample(STREET_TYPES, random)}`

	if (template === "h-adversarial") {
		// US street, leading real-ZIP house number, with a trailing postcode → the leading is house_number.
		const zip = sample(realZips, random)
		const t = sample(US_TUPLES, random)
		const raw = `${zip} ${street}, ${t.locality}, ${t.region} ${t.postcode}`

		return {
			raw,
			components: { house_number: zip, street, locality: t.locality, region: t.region, postcode: t.postcode },
			locale: "en-US",
			template,
		}
	}

	if (template === "p-us-rural") {
		// US rural, leading postcode, no trailing postcode → the leading is the postcode (the A0-erosion fix).
		const zip = sample(realZips, random)
		const region = sample(RURAL_REGIONS, random)
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
		const d = sample(DE_TUPLES, random)
		const hn = sample(HOUSE_NUMS, random)
		const raw = `${d.postcode} ${d.locality}, ${d.street} ${hn}`

		return {
			raw,
			components: { postcode: d.postcode, locality: d.locality, street: d.street, house_number: hn },
			locale: "de-DE",
			template,
		}
	}

	if (template === "anchor-fp") {
		// Leading 5-digit that is not a real ZIP (the anchor misses) + trailing postcode → still house_number.
		const fake = sample(FAKE_ZIPS, random)
		const t = sample(US_TUPLES, random)
		const raw = `${fake} ${street}, ${t.locality}, ${t.region} ${t.postcode}`

		return {
			raw,
			components: { house_number: fake, street, locality: t.locality, region: t.region, postcode: t.postcode },
			locale: "en-US",
			template,
		}
	}

	if (template === "locale-ambig") {
		// Minimal context — the local token decides. Half: "{realZip} {street}" (street-type → house#);
		// half: "{realZip} {locality}" (no street, leading postcode → postcode). No trailing, no region.
		const zip = sample(realZips, random)

		if (random() < 0.5) {
			return { raw: `${zip} ${street}`, components: { house_number: zip, street }, locale: "en-US", template }
		}

		const t = sample(US_TUPLES, random)

		return {
			raw: `${zip} ${t.locality}`,
			components: { postcode: zip, locality: t.locality },
			locale: "en-US",
			template,
		}
	}

	if (template === "h-no-trailing-locality") {
		// The A3 fix (#220): the common US format "{house#} {street}, {locality}, {state}" with no trailing
		// postcode → the leading number is the house number. The contrast to p-us-rural (same no-trailing,
		// state-containing shape) is the locality: present here, absent there. The A2 recipe output lacked this template,
		// so p-us-rural's "leading-number + state → postcode" rule over-generalized to 98 golden house#
		// rows ("36 Oxbow Dr, Bradford, VT" → postcode). The house# spans 1-4 digits and real 5-digit ZIPs
		// (the hard case: 5-digit + locality is still a house number, distinct from p-us-rural's no-locality).
		const hn = houseNum(random, realZips)
		const t = sample(US_TUPLES, random)
		const region = random() < 0.5 ? sample(RURAL_REGIONS, random) : t.region
		const raw = `${hn} ${street}, ${t.locality}, ${region}`

		return {
			raw,
			components: { house_number: hn, street, locality: t.locality, region },
			locale: "en-US",
			template,
		}
	}

	// standard: normal house number + trailing postcode → house_number (baseline, keeps the common case).
	const hn = houseNum(random, realZips)
	const t = sample(US_TUPLES, random)
	const raw = `${hn} ${street}, ${t.locality}, ${t.region} ${t.postcode}`

	return {
		raw,
		components: { house_number: hn, street, locality: t.locality, region: t.region, postcode: t.postcode },
		locale: "en-US",
		template,
	}
}

// Weighted template bag — the template mix. Expanded to a flat array so `sample` draws at the target
// frequencies (matches the boundary-stress ALL_TEMPLATES idiom).
//
// A3 (#220, after the per-row diagnostic on the A2 probe): A1/A2 both held case-H (100) + postcode
// (~98) but cost house_number (95.8->92.8), and the A2 mix-rebalance did not move it — so it was never a
// case-P-quantity problem. The row-by-row v192-vs-A2 diff (hn-regression-diff.ts) pinned it: 132/132 house#
// regressions were house#->postcode on "{house#} {street}, {locality}, {state}" no-trailing rows — the
// p-us-rural rule ("leading-number + state + no-trailing -> postcode") over-generalized because the recipe output
// had no counter-template for the common locality-containing house# case. A3 adds h-no-trailing-locality (15%)
// to teach the locality discriminator (present -> house#, absent + 5-digit -> postcode = p-us-rural) and
// trims p-us-rural 16->13. Goal: house_number recovers without re-eroding postcode/case-H. case-P = 26%.
/**
 * Every anchor-absorption template, in one list for the recipe to sample from. Each covers a way a venue or landmark
 * name can swallow the street token that follows it.
 */
export const ALL_TEMPLATES: ReadonlyArray<AnchorAbsorptionTemplate> = [
	...new Array<AnchorAbsorptionTemplate>(25).fill("h-adversarial"),
	...new Array<AnchorAbsorptionTemplate>(15).fill("h-no-trailing-locality"),
	...new Array<AnchorAbsorptionTemplate>(13).fill("p-us-rural"),
	...new Array<AnchorAbsorptionTemplate>(13).fill("p-de"),
	...new Array<AnchorAbsorptionTemplate>(8).fill("anchor-fp"),
	...new Array<AnchorAbsorptionTemplate>(14).fill("locale-ambig"),
	...new Array<AnchorAbsorptionTemplate>(12).fill("standard"),
]
