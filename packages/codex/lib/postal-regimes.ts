/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postal regimes: the delivery systems whose parser unit is not the ISO 3166-1 country code.
 *
 *   Most of the tree keys addressing behavior by country, and for most of the world that is the right unit. Seven
 *   families break it. One ISO code can carry three separate postal systems (`SH`). A country's own routing vocabulary
 *   can sit beside its geography without being part of it (`AA`/`AE`/`AP` are not US states, and a BFPO number is not a
 *   GB postcode). A postcode system can cross a political border. An address can be written as a landmark and a
 *   direction rather than as a street and a number.
 *
 *   Each record names the regime, the ISO code it sits under, and what this repository models for it today. That last
 *   field is the point: {@linkcode RegimeCoverage.Unmodeled} says no layout, lexicon or check treats this regime as
 *   distinct from its parent country, which means an address written in it is parsed as though it were an ordinary
 *   address of the parent. Recording that is what separates a known gap from an unnoticed one.
 *
 *   This table describes regimes. It synthesizes no conventions: a regime reading `unmodeled` gets no invented layout
 *   here, and the 158 jurisdictions whose source-register backbone state is `C` get no entry at all unless a regime
 *   named below covers them. The source for the seven families is the global address corpus specification §7 (#2323).
 */

/**
 * What this repository models for a regime.
 */
export const RegimeCoverage = {
	/**
	 * A layout, lexicon, postcode shape or check treats the regime as distinct from its parent country.
	 */
	Modeled: "modeled",
	/**
	 * Something partial exists and does not cover the regime's own addressing. The record says what is missing.
	 */
	Partial: "partial",
	/**
	 * Nothing distinguishes the regime from its parent country. An address written in it parses as an ordinary address of
	 * that country, which is a stated gap rather than a decision that the regime does not exist.
	 */
	Unmodeled: "unmodeled",
} as const

export type RegimeCoverage = (typeof RegimeCoverage)[keyof typeof RegimeCoverage]

/**
 * Why a regime's parser unit differs from its ISO country code.
 */
export const RegimeKind = {
	/**
	 * One ISO code carries more than one postal system, each with its own conventions.
	 */
	SplitJurisdiction: "split-jurisdiction",
	/**
	 * Routing identifiers that occupy the shape of geography without being geography — a pseudo-state, a forces number.
	 */
	Routing: "routing",
	/**
	 * A postcode or routing convention that crosses a political border.
	 */
	CrossBorder: "cross-border",
	/**
	 * An address written as a landmark, a direction and a distance rather than as a street and a number.
	 */
	Narrative: "narrative",
	/**
	 * A code that appears in real data and is not ISO 3166-1. Accepting one is an operational decision and states nothing
	 * about sovereignty.
	 */
	Operational: "operational",
} as const

export type RegimeKind = (typeof RegimeKind)[keyof typeof RegimeKind]

export interface PostalRegime {
	/**
	 * Stable identifier, kebab-case. Never an ISO code, so a regime is never mistaken for a country.
	 */
	regimeID: string
	name: string
	kind: RegimeKind
	/**
	 * The ISO 3166-1 alpha-2 codes an address in this regime carries, or would carry. More than one where the regime
	 * crosses a border.
	 */
	iso2: readonly string[]
	coverage: RegimeCoverage
	/**
	 * What an address in this regime looks like, in enough detail to recognize one. Written from the specification rather
	 * than measured against a corpus, so it describes the regime and claims no row counts.
	 */
	shape: string
	/**
	 * What the repository does with such an address today, and what is missing when coverage is not `modeled`.
	 */
	note: string
}

/**
 * The seven families the global address corpus specification §7 names, as records.
 *
 * Every one reads `unmodeled` today. That is the measurement this table was written to record: the repository keys
 * addressing behavior by ISO country code throughout, so none of these regimes is distinguished from its parent
 * anywhere in the tree.
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
 * The regime with this id, or `undefined`.
 */
export function postalRegimeByID(regimeID: string): PostalRegime | undefined {
	return REGIME_BY_ID.get(regimeID)
}

/**
 * Every regime an address carrying this ISO code could be written in.
 *
 * An empty array means no regime named here covers the country. It does not mean the country's addresses are ordinary:
 * a regime nobody has written down is absent from this table exactly as one that does not exist is.
 */
export function postalRegimesForCountry(iso2: string): readonly PostalRegime[] {
	const code = iso2.trim().toUpperCase()

	return POSTAL_REGIMES.filter((regime) => regime.iso2.includes(code))
}
