/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   USPS Publication 28, Appendix C — Postal Service Standard Suffix Abbreviations.
 *
 *   For each canonical suffix the value lists every recognized variant in USPS-published order; the
 *   first variant is the preferred USPS abbreviation (e.g. `AVENUE → ["AVE", "AV", "AVEN", "AVENU",
 *   "AVN", "AVNUE"]` — `AVE` is what the post office prints).
 *
 *   This module is the single home for the USPS suffix table. It carries both the synthesis-layer
 *   helpers (`US_STREET_SUFFIX_PREFERRED_ABBR`, `matchCase`, `matchTrailingSuffix` — used by
 *   `@mailwoman/corpus`) and the richer branded-type lookup (`StreetSuffix`, `lookupStreetSuffix`,
 *   `isStreetSuffix`) The data is verbatim USPS Pub-28; the two APIs share one underlying record.
 * @see {@link https://pe.usps.com/text/pub28/28apc_002.htm USPS Street Suffix Abbreviations}
 */

/**
 * Canonical USPS street suffix → list of recognized variants. The first variant in each list is the preferred USPS
 * abbreviation. Keys + values are uppercase per the publication.
 */
export const US_STREET_SUFFIX_VARIANTS = {
	ALLEY: ["ALY", "ALLEE", "ALLY"],
	ANEX: ["ANX", "ANNEX", "ANNX"],
	ARCADE: ["ARC"],
	AVENUE: ["AVE", "AV", "AVEN", "AVENU", "AVN", "AVNUE"],
	BAYOU: ["BYU", "BAYOO"],
	BEACH: ["BCH"],
	BEND: ["BND"],
	BLUFF: ["BLF", "BLUF"],
	BLUFFS: ["BLFS"],
	BOTTOM: ["BTM", "BOT", "BOTTM"],
	BOULEVARD: ["BLVD", "BOUL", "BOULV"],
	BRANCH: ["BR", "BRNCH"],
	BRIDGE: ["BRG", "BRDGE"],
	BROOK: ["BRK"],
	BROOKS: ["BRKS"],
	BURG: ["BG"],
	BURGS: ["BGS"],
	BYPASS: ["BYP", "BYPA", "BYPAS", "BYPS"],
	CAMP: ["CP", "CMP"],
	CANYON: ["CYN", "CANYN", "CNYN"],
	CAPE: ["CPE"],
	CAUSEWAY: ["CSWY", "CAUSWA"],
	CENTER: ["CTR", "CEN", "CENT", "CENTR", "CENTRE", "CNTER", "CNTR"],
	CENTERS: ["CTRS"],
	CIRCLE: ["CIR", "CIRC", "CIRCL", "CRCL", "CRCLE"],
	CIRCLES: ["CIRS"],
	CLIFF: ["CLF"],
	CLIFFS: ["CLFS"],
	CLUB: ["CLB"],
	COMMON: ["CMN"],
	COMMONS: ["CMNS"],
	CORNER: ["COR"],
	CORNERS: ["CORS"],
	COURSE: ["CRSE"],
	COURT: ["CT"],
	COURTS: ["CTS"],
	COVE: ["CV"],
	COVES: ["CVS"],
	CREEK: ["CRK"],
	CRESCENT: ["CRES", "CRSENT", "CRSNT"],
	CREST: ["CRST"],
	CROSSING: ["XING", "CRSSNG"],
	CROSSROAD: ["XRD"],
	CROSSROADS: ["XRDS"],
	CURVE: ["CURV"],
	DALE: ["DL"],
	DAM: ["DM"],
	DIVIDE: ["DV", "DIV", "DVD"],
	DRIVE: ["DR", "DRIV", "DRV"],
	DRIVES: ["DRS"],
	ESTATE: ["EST"],
	ESTATES: ["ESTS"],
	EXPRESSWAY: ["EXPY", "EXP", "EXPR", "EXPRESS", "EXPW"],
	EXTENSION: ["EXT", "EXTN", "EXTNSN"],
	EXTENSIONS: ["EXTS"],
	FALL: ["FALL"],
	FALLS: ["FLS"],
	FERRY: ["FRY", "FRRY"],
	FIELD: ["FLD"],
	FIELDS: ["FLDS"],
	FLAT: ["FLT"],
	FLATS: ["FLTS"],
	FORD: ["FRD"],
	FORDS: ["FRDS"],
	FOREST: ["FRST", "FORESTS"],
	FORGE: ["FRG", "FORG"],
	FORGES: ["FRGS"],
	FORK: ["FRK"],
	FORKS: ["FRKS"],
	FORT: ["FT", "FRT"],
	FREEWAY: ["FWY", "FREEWY", "FRWAY", "FRWY"],
	GARDEN: ["GDN", "GARDN", "GRDEN", "GRDN"],
	GARDENS: ["GDNS", "GRDNS"],
	GATEWAY: ["GTWY", "GATEWY", "GATWAY", "GTWAY"],
	GLEN: ["GLN"],
	GLENS: ["GLNS"],
	GREEN: ["GRN"],
	GREENS: ["GRNS"],
	GROVE: ["GRV", "GROV"],
	GROVES: ["GRVS"],
	HARBOR: ["HBR", "HARB", "HARBR", "HRBOR"],
	HARBORS: ["HBRS"],
	HAVEN: ["HVN"],
	HEIGHTS: ["HTS", "HT"],
	HIGHWAY: ["HWY", "HIGHWY", "HIWAY", "HIWY", "HWAY"],
	HILL: ["HL"],
	HILLS: ["HLS"],
	HOLLOW: ["HOLW", "HLLW", "HOLLOWS", "HOLWS"],
	INLET: ["INLT"],
	ISLAND: ["IS", "ISLND"],
	ISLANDS: ["ISS", "ISLNDS"],
	ISLE: ["ISLE", "ISLES"],
	JUNCTION: ["JCT", "JCTION", "JCTN", "JUNCTN", "JUNCTON"],
	JUNCTIONS: ["JCTS", "JCTNS"],
	KEY: ["KY"],
	KEYS: ["KYS"],
	KNOLL: ["KNL", "KNOL"],
	KNOLLS: ["KNLS"],
	LAKE: ["LK"],
	LAKES: ["LKS"],
	LAND: ["LAND"],
	LANDING: ["LNDG", "LNDNG"],
	LANE: ["LN"],
	LIGHT: ["LGT"],
	LIGHTS: ["LGTS"],
	LOAF: ["LF"],
	LOCK: ["LCK"],
	LOCKS: ["LCKS"],
	LODGE: ["LDG", "LDGE", "LODG"],
	LOOP: ["LOOP", "LOOPS"],
	MALL: ["MALL"],
	MANOR: ["MNR"],
	MANORS: ["MNRS"],
	MEADOW: ["MDW"],
	MEADOWS: ["MDWS", "MDW", "MEDOWS"],
	MEWS: ["MEWS"],
	MILL: ["ML"],
	MILLS: ["MLS"],
	MISSION: ["MSN", "MISSN", "MSSN"],
	MOTORWAY: ["MTWY"],
	MOUNT: ["MT", "MNT"],
	MOUNTAIN: ["MTN", "MNTAIN", "MNTN", "MOUNTIN", "MTIN"],
	MOUNTAINS: ["MTNS", "MNTNS"],
	NECK: ["NCK"],
	ORCHARD: ["ORCH", "ORCHRD"],
	OVAL: ["OVAL", "OVL"],
	OVERPASS: ["OPAS"],
	PARK: ["PARK", "PRK", "PARKS"],
	PARKWAY: ["PKWY", "PARKWY", "PKWAY", "PKY"],
	PARKWAYS: ["PKWY", "PKWYS"],
	PASS: ["PASS"],
	PASSAGE: ["PSGE"],
	PATH: ["PATH", "PATHS"],
	PIKE: ["PIKE", "PIKES"],
	PINE: ["PNE"],
	PINES: ["PNES"],
	PLACE: ["PL"],
	PLAIN: ["PLN"],
	PLAINS: ["PLNS"],
	PLAZA: ["PLZ", "PLZA"],
	POINT: ["PT"],
	POINTS: ["PTS"],
	PORT: ["PRT"],
	PORTS: ["PRTS"],
	PRAIRIE: ["PR", "PRR"],
	RADIAL: ["RADL", "RAD", "RADIEL"],
	RAMP: ["RAMP"],
	RANCH: ["RNCH", "RANCHES", "RNCHS"],
	RAPID: ["RPD"],
	RAPIDS: ["RPDS"],
	REST: ["RST"],
	RIDGE: ["RDG", "RDGE"],
	RIDGES: ["RDGS"],
	RIVER: ["RIV", "RVR", "RIVR"],
	ROAD: ["RD"],
	ROADS: ["RDS"],
	ROUTE: ["RTE"],
	ROW: ["ROW"],
	RUE: ["RUE"],
	RUN: ["RUN"],
	SHOAL: ["SHL"],
	SHOALS: ["SHLS"],
	SHORE: ["SHR", "SHOAR"],
	SHORES: ["SHRS", "SHOARS"],
	SKYWAY: ["SKWY"],
	SPRING: ["SPG", "SPNG", "SPRNG"],
	SPRINGS: ["SPGS", "SPNGS", "SPRNGS"],
	SPUR: ["SPUR"],
	SPURS: ["SPUR"],
	SQUARE: ["SQ", "SQR", "SQRE", "SQU"],
	SQUARES: ["SQS", "SQRS"],
	STATION: ["STA", "STATN", "STN"],
	STRAVENUE: ["STRA", "STRAV", "STRAVEN", "STRAVN", "STRVN", "STRVNUE"],
	STREAM: ["STRM", "STREME"],
	STREET: ["ST", "STRT", "STR"],
	STREETS: ["STS"],
	SUMMIT: ["SMT", "SUMIT", "SUMITT"],
	TERRACE: ["TER", "TERR"],
	THROUGHWAY: ["TRWY"],
	TRACE: ["TRCE", "TRACES"],
	TRACK: ["TRAK", "TRACKS", "TRK", "TRKS"],
	TRAFFICWAY: ["TRFY"],
	TRAIL: ["TRL", "TRAILS", "TRLS"],
	TRAILER: ["TRLR", "TRLRS"],
	TUNNEL: ["TUNL", "TUNEL", "TUNLS", "TUNNELS", "TUNNL"],
	TURNPIKE: ["TPKE", "TRNPK", "TURNPK"],
	UNDERPASS: ["UPAS"],
	UNION: ["UN"],
	UNIONS: ["UNS"],
	VALLEY: ["VLY", "VALLY", "VLLY"],
	VALLEYS: ["VLYS"],
	VIADUCT: ["VIA", "VDCT", "VIADCT"],
	VIEW: ["VW"],
	VIEWS: ["VWS"],
	VILLAGE: ["VLG", "VILL", "VILLAG", "VILLG", "VILLIAGE"],
	VILLAGES: ["VLGS"],
	VILLE: ["VL"],
	VISTA: ["VIS", "VIST", "VST", "VSTA"],
	WALK: ["WALK"],
	WALKS: ["WALK"],
	WALL: ["WALL"],
	WAY: ["WAY", "WY"],
	WAYS: ["WAYS"],
	WELL: ["WL"],
	WELLS: ["WLS"],
} as const satisfies Record<string, readonly string[]>

/** Canonical USPS suffix (full word, uppercase per the publication). */
export type USStreetSuffix = keyof typeof US_STREET_SUFFIX_VARIANTS

/**
 * Inverse lookup: every variant abbreviation OR full canonical word → its canonical key. Built once at module load,
 * lowercase-keyed for case-insensitive matching (`street` → `"STREET"`, `st` → `"STREET"`, `strt` → `"STREET"`, …).
 */
export const US_STREET_SUFFIX_LOOKUP: ReadonlyMap<string, USStreetSuffix> = (() => {
	const out = new Map<string, USStreetSuffix>()

	for (const canonical of Object.keys(US_STREET_SUFFIX_VARIANTS) as USStreetSuffix[]) {
		out.set(canonical.toLowerCase(), canonical)

		for (const variant of US_STREET_SUFFIX_VARIANTS[canonical]) {
			// Don't overwrite — first canonical that claims a variant wins (matches USPS Pub-28's
			// ordering). E.g. "WALK" and "WALKS" both list "WALK" as a variant; "WALK" wins because it
			// sorts first in `Object.keys`.
			if (!out.has(variant.toLowerCase())) {
				out.set(variant.toLowerCase(), canonical)
			}
		}
	}

	return out
})()

/** Preferred USPS abbreviation per canonical (`AVENUE → "AVE"`, `STREET → "ST"`). */
export const US_STREET_SUFFIX_PREFERRED_ABBR: Readonly<Record<USStreetSuffix, string>> = Object.fromEntries(
	(Object.keys(US_STREET_SUFFIX_VARIANTS) as USStreetSuffix[]).map((k) => [k, US_STREET_SUFFIX_VARIANTS[k][0]])
) as Readonly<Record<USStreetSuffix, string>>

/**
 * Apply `target`'s letters in the same case-pattern as `reference`. Three patterns covered:
 *
 * - All-uppercase reference (`"AVE"`) → uppercase target (`"AVENUE"`).
 * - All-lowercase reference (`"ave"`) → lowercase target (`"avenue"`).
 * - Anything else (`"Ave"`, `"aVe"`) → title-case target (`"Avenue"`).
 */
export function matchCase(target: string, reference: string): string {
	if (!reference) return target

	if (reference === reference.toUpperCase()) return target.toUpperCase()

	if (reference === reference.toLowerCase()) return target.toLowerCase()

	return target.charAt(0).toUpperCase() + target.slice(1).toLowerCase()
}

/**
 * If the last whitespace-separated word of `street` is a known USPS suffix variant, return the canonical key and the
 * matched word. Returns null if the trailing word isn't a known suffix.
 */
export function matchTrailingSuffix(street: string): { canonical: USStreetSuffix; matched: string } | null {
	const trimmed = street.trim()

	if (!trimmed) return null
	const parts = trimmed.split(/\s+/)
	const last = parts[parts.length - 1]!
	const canonical = US_STREET_SUFFIX_LOOKUP.get(last.toLowerCase())

	if (!canonical) return null

	return { canonical, matched: last }
}

/**
 * The USPS suffix record, under its original isp-nexus name. Aliases {@link US_STREET_SUFFIX_VARIANTS}.
 */
export const StreetSuffixAbbreviationRecord = US_STREET_SUFFIX_VARIANTS
export type StreetSuffixAbbreviationRecord = typeof US_STREET_SUFFIX_VARIANTS

/**
 * A canonical USPS street suffix, i.e. "STREET", "AVENUE", "BOULEVARD". Aliases {@link USStreetSuffix}.
 */
export type StreetSuffix = USStreetSuffix

/** A standardized USPS street suffix abbreviation (the preferred form), i.e. "ST", "AVE", "BLVD". */
export type USPSStandardSuffixAbbreviation = StreetSuffixAbbreviationRecord[StreetSuffix][0]

/** Any USPS-recognized suffix variant or abbreviation. */
export type StreetSuffixAbbreviation = StreetSuffixAbbreviationRecord[StreetSuffix][number]

/** Result of a successful USPS street suffix lookup. */
export interface StreetSuffixMatch<S extends StreetSuffix = StreetSuffix> {
	/** The matched canonical USPS street suffix, i.e. "STREET", "AVENUE". */
	suffix: S
	/** The preferred USPS street suffix abbreviation, i.e. "ST", "AVE". */
	abbreviation: StreetSuffixAbbreviationRecord[S][0]
}

/**
 * Look up a USPS street suffix (by canonical word, abbreviation, or any variant) and its preferred abbreviation.
 */
export function lookupStreetSuffix<S extends StreetSuffix>(suffix: S): StreetSuffixMatch<S>
export function lookupStreetSuffix(input: string | null | undefined): StreetSuffixMatch | null
export function lookupStreetSuffix(input: string | null | undefined): StreetSuffixMatch | null {
	if (!input || typeof input !== "string") return null
	const suffix = US_STREET_SUFFIX_LOOKUP.get(input.trim().toLowerCase())

	if (!suffix) return null

	return { suffix, abbreviation: US_STREET_SUFFIX_VARIANTS[suffix][0] }
}

/** Type-predicate: is the input a canonical USPS street suffix (uppercase full word, e.g. "STREET")? */
export function isStreetSuffix(input: unknown): input is StreetSuffix {
	return typeof input === "string" && Object.hasOwn(US_STREET_SUFFIX_VARIANTS, input)
}

/**
 * True when a token is any USPS street suffix or abbreviation (case-insensitive) — `"St"`, `"BLVD"`, `"trail"`.
 */
export function isStreetSuffixToken(input: unknown): boolean {
	return typeof input === "string" && US_STREET_SUFFIX_LOOKUP.has(input.trim().toLowerCase())
}
