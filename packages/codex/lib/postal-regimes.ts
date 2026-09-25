/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postal regimes whose addressing does not follow their ISO 3166-1 country code.
 *
 *   Most code keys addressing behavior by country. The regimes here are exceptions: one code with several postal
 *   systems, routing codes shaped like geography, postcodes that cross borders, and addresses written as
 *   landmark directions. Each record states how much of the regime this repository models, which keeps known
 *   gaps visible. The table records regimes only and defines no layouts. The seven families come from section 7
 *   of the global address corpus specification.
 */

/**
 * How much of a regime this repository models.
 */
export const RegimeCoverage = {
	/**
	 * A layout, lexicon, postcode shape or check treats the regime separately from its parent country.
	 */
	Modeled: "modeled",
	/**
	 * Some support exists, but it does not cover the regime's own addressing.
	 * The record's note lists the gaps.
	 */
	Partial: "partial",
	/**
	 * Addresses in the regime parse as ordinary addresses of the parent country.
	 */
	Unmodeled: "unmodeled",
} as const

/**
 * A coverage level.
 */
export type RegimeCoverage = (typeof RegimeCoverage)[keyof typeof RegimeCoverage]

/**
 * The reason a regime's addressing differs from its ISO country code.
 */
export const RegimeKind = {
	/**
	 * One ISO code covers several postal systems.
	 */
	SplitJurisdiction: "split-jurisdiction",
	/**
	 * Routing codes shaped like geography, such as a military pseudo-state or a forces number.
	 */
	Routing: "routing",
	/**
	 * A postcode or routing convention that crosses a political border.
	 */
	CrossBorder: "cross-border",
	/**
	 * An address written as a landmark, a direction and a distance.
	 */
	Narrative: "narrative",
	/**
	 * A code that appears in real data outside ISO 3166-1.
	 * Accepting it implies nothing about sovereignty.
	 */
	Operational: "operational",
} as const

/**
 * A regime kind.
 */
export type RegimeKind = (typeof RegimeKind)[keyof typeof RegimeKind]

/**
 * One postal regime record.
 */
export interface PostalRegime {
	/**
	 * A stable kebab-case ID.
	 *
	 * It is never an ISO code, so it cannot be confused with a country.
	 */
	regimeID: string
	name: string
	kind: RegimeKind
	/**
	 * The ISO 3166-1 alpha-2 codes that addresses in this regime use.
	 * A cross-border regime lists several.
	 */
	iso2: readonly string[]
	coverage: RegimeCoverage
	/**
	 * A description of the regime's addresses, taken from the specification.
	 */
	shape: string
	/**
	 * How the repository currently handles these addresses and what is missing.
	 */
	note: string
}

/**
 * The seven regime families from the global address corpus specification.
 */
export const POSTAL_REGIMES: readonly PostalRegime[] = [
	{
		regimeID: "saint-helena-three-territories",
		name: "Saint Helena, Ascension and Tristan da Cunha",
		kind: RegimeKind.SplitJurisdiction,
		iso2: ["SH"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"Three postal systems under one ISO code, separated by over a thousand kilometers of ocean and sharing no " +
			"locality names. Saint Helena writes `STHL 1ZZ`, Ascension `ASCN 1ZZ`, Tristan da Cunha `TDCU 1ZZ`.",
		note: "One SH country key, so the three read as one place. The postcode prefixes are the separating signal and nothing consults them.",
	},
	{
		regimeID: "us-military-mail",
		name: "US military and diplomatic mail (APO/FPO/DPO)",
		kind: RegimeKind.Routing,
		iso2: ["US"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"`APO`, `FPO` or `DPO` stands where a locality does, and the pseudo-state is `AA`, `AE` or `AP`. " +
			"`UNIT 2050 BOX 4190, APO AP 96278` is the shape. The ZIP is an ordinary five-digit US code.",
		note:
			"`AA`/`AE`/`AP` are absent from the US state table, so a region slot holding one is unresolvable while " +
			"looking like an ordinary two-letter state. The address is routing, and nothing in it names a place on the ground.",
	},
	{
		regimeID: "uk-forces-post-office",
		name: "British Forces Post Office (BFPO)",
		kind: RegimeKind.Routing,
		iso2: ["GB"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"`BFPO` plus a number stands for the whole admin tail — `Ship's Name, BFPO 204`. A parallel postcode form " +
			"exists (`BF1 3AA`) whose outward code no GB postcode area otherwise uses.",
		note:
			"Parsed as an ordinary GB address, so `BFPO 204` competes with the locality and postcode slots. The " +
			"`BF1` outward code is not in the Code-Point Open extract the en-GB overlay ships.",
	},
	{
		regimeID: "station-addressed-territories",
		name: "Station-addressed territories",
		kind: RegimeKind.Routing,
		iso2: ["TF", "AQ", "GS", "IO"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"A station, base, district or organization name stands where a street hierarchy would — a research station, " +
			"a garrison, a scientific programme. There is often no street and no postcode.",
		note:
			"All four read `0` stages in the coverage funnel or close to it. An address here has no street to find, so " +
			"a parse that returns no street is correct and a resolver that expects one has nothing to match.",
	},
	{
		regimeID: "european-microstate-postal-unions",
		name: "European microstate postal unions",
		kind: RegimeKind.CrossBorder,
		iso2: ["VA", "SM", "MC", "LI", "IT", "CH"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"A postcode system administered by a neighbour crosses the political border. Vatican City and San Marino " +
			"take Italian codes (`00120`, `4789x`), Monaco French ones (`980xx`), Liechtenstein Swiss ones (`948x`).",
		note:
			"A postcode-to-country check reading the code alone answers the administering country, so a Vatican " +
			"address can resolve as Italian. Whether any check does is unverified — this record names the regime, not a defect.",
	},
	{
		regimeID: "narrative-address-family",
		name: "Narrative addresses",
		kind: RegimeKind.Narrative,
		iso2: ["CR", "NI", "PA"],
		coverage: RegimeCoverage.Unmodeled,
		shape:
			"A landmark, a direction and a distance in place of a street and a number — `De la iglesia católica, 200 " +
			"metros al sur`. The landmark may no longer exist and still be the address.",
		note:
			"No component tag holds a direction or a distance, so a narrative address has no correct parse under the " +
			"current schema rather than a parse the model gets wrong. Widening the schema is the prerequisite (#2276).",
	},
	{
		regimeID: "operational-non-iso-codes",
		name: "Non-ISO operational codes",
		kind: RegimeKind.Operational,
		iso2: ["XK"],
		coverage: RegimeCoverage.Partial,
		shape:
			"A code that appears in real data and is not ISO 3166-1. `XK` for Kosovo is the one this repository carries.",
		note:
			"The source register enumerates `XK` as its 250th jurisdiction, so it is counted. No layout, postcode shape " +
			"or lexicon names it. Accepting the code states nothing about sovereignty.",
	},
]

const REGIME_BY_ID = new Map(POSTAL_REGIMES.map((regime) => [regime.regimeID, regime]))

/**
 * Returns the regime with this ID, or `undefined`.
 */
export function postalRegimeByID(regimeID: string): PostalRegime | undefined {
	return REGIME_BY_ID.get(regimeID)
}

/**
 * Returns every recorded regime that uses this ISO code.
 *
 * An empty result means only that this table records no regime for the country.
 */
export function postalRegimesForCountry(iso2: string): readonly PostalRegime[] {
	const code = iso2.trim().toUpperCase()

	return POSTAL_REGIMES.filter((regime) => regime.iso2.includes(code))
}
