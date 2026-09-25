/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates address pairs in which context decides whether a leading five-digit token is a house number or a postcode.
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

/**
 * A US locality, region and postcode used as an address tail.
 */
export interface AnchorAbsorptionBaseTuple {
	locality: string
	region: string
	postcode: string
}

/**
 * The row templates.
 *
 * Names that start with `h-` produce a house number and names that start with `p-` a postcode.
 */
export type AnchorAbsorptionTemplate =
	| "h-adversarial"
	| "h-no-trailing-locality"
	| "p-us-rural"
	| "p-de"
	| "anchor-fp"
	| "locale-ambig"
	| "standard"

/**
 * Options for {@link synthesizeAnchorAbsorptionRow}.
 */
export interface AnchorAbsorptionSynthesisOpts {
	random?: () => number
	forceTemplate?: AnchorAbsorptionTemplate
	/**
	 * Real US ZIP codes from the postcode-anchor lookup.
	 *
	 * The templates place them where the anchor fires on a token that is really a house number.
	 * The default is the postcodes of the built-in US tuples.
	 */
	realZips?: ReadonlyArray<string>
}

/**
 * One synthesized row with its template.
 */
export interface SynthesizedAnchorAbsorptionRow {
	raw: string
	components: Partial<Record<ComponentTag, string>>
	locale: string
	template: AnchorAbsorptionTemplate
}

/**
 * Samples a house number, which is a real ZIP code a quarter of the time.
 */
function houseNum(random: () => number, realZips: ReadonlyArray<string>): string {
	if (random() < 0.25) return sample(realZips, random)

	return String(1 + Math.floor(random() * 9999))
}

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

const RURAL_REGIONS = ["VT", "ND", "SD", "NH", "ME", "MT", "WY"]

const DE_TUPLES = [
	{ postcode: "10115", locality: "Berlin", street: "Hauptstraße" },
	{ postcode: "80331", locality: "München", street: "Sendlinger Straße" },
	{ postcode: "20095", locality: "Hamburg", street: "Mönckebergstraße" },
	{ postcode: "50667", locality: "Köln", street: "Hohe Straße" },
	{ postcode: "01067", locality: "Dresden", street: "Prager Straße" },
]

const HOUSE_NUMS = ["5", "12", "27", "100", "212", "1450", "8"]
// These five-digit values must stay absent from the postcode lookup.
const FAKE_ZIPS = ["00000", "99998", "99997", "00001", "99996"]

/**
 * Builds one row from a sampled or forced template.
 */
export function synthesizeAnchorAbsorptionRow(
	opts: AnchorAbsorptionSynthesisOpts = {}
): SynthesizedAnchorAbsorptionRow {
	const random = opts.random ?? Math.random
	const realZips = opts.realZips && opts.realZips.length ? opts.realZips : US_TUPLES.map((t) => t.postcode)
	const template = opts.forceTemplate ?? sample(ALL_TEMPLATES, random)
	const street = `${sample(STREET_NAMES, random)} ${sample(STREET_TYPES, random)}`

	if (template === "h-adversarial") {
		// The trailing postcode makes the leading real ZIP code a house number.
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
		// Without a locality or trailing postcode, the leading value is the postcode.
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
		// A five-digit value absent from the ZIP lookup is still a house number here.
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
		// A following street makes the value a house number, and a following locality makes it a postcode.
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
		// The locality separates this form from the rural postcode-first form.
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

/**
 * The template sampling pool, in which each template's repeat count is its weight.
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
