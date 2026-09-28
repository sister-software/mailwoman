/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical admin-gazetteer coverage recipe. It lives here, reviewed like code, while
 *   `data/gazetteer/wof-build-manifest.json` is a build log recording what ran, when, and the md5.
 *
 *   The lists map id ranges to sources: WOF rows (`id < 2e9`) are the priority countries, Overture
 *   divisions (`8e12 ≤ id < 9e12`) are the 86, and the GeoNames alias fold (`id ≥ 9e12`) is the 161.
 *   See releasing.md "Rebuilding + swapping the canonical admin gazetteer".
 *
 * 	 TODO: Move most of this to JSON configuration files.
 */

/**
 * The locales whose WOF GeoJSON repos are cloned + ingested directly (`<repos>/whosonfirst-data*`).
 */
export const DEFAULT_WOF_PRIORITY_COUNTRIES = [
	"CN",
	"DE",
	"ES",
	"FR",
	"GB",
	// `whosonfirst-data-admin-in` carries 189,026 sub-locality nodes, converting at 98.6% into
	// 186,469 (child, parent) pairs. IN stays out of DEFAULT_OVERTURE_COUNTRIES, because a country
	// served by both would double up its admin.
	"IN",
	"IT",
	"JP",
	"KR",
	"NL",
	"TW",
	"US",
] as const

/**
 * Overture `divisions`-theme backfill set (synthetic ids @ 8e12) for the zero-WOF-repo locales.
 */
export const DEFAULT_OVERTURE_COUNTRIES = [
	"AE",
	"AO",
	"AR",
	"AT",
	"AU",
	"BD",
	"BE",
	"BG",
	"BH",
	"BO",
	"BR",
	"BY",
	"CA",
	"CH",
	"CI",
	"CL",
	"CM",
	"CO",
	"CR",
	"CU",
	"CZ",
	"DK",
	"DO",
	"DZ",
	"EC",
	"EE",
	"EG",
	"ET",
	"FI",
	"GH",
	"GR",
	"GT",
	"HR",
	"HU",
	"ID",
	"IE",
	"IL",
	// "IN" lives in DEFAULT_WOF_PRIORITY_COUNTRIES.
	"IQ",
	"IR",
	"IS",
	"JO",
	"KE",
	"KH",
	"KW",
	"KZ",
	"LB",
	"LK",
	"LT",
	"LU",
	"LV",
	"MA",
	"MM",
	"MX",
	"MY",
	"NG",
	"NO",
	"NP",
	"NZ",
	"OM",
	"PA",
	"PE",
	"PH",
	"PK",
	"PL",
	"PT",
	"QA",
	"RO",
	"RS",
	"RU",
	"SA",
	"SE",
	"SG",
	"SI",
	"SK",
	"SN",
	"TH",
	"TN",
	"TR",
	"TZ",
	"UA",
	"UG",
	"UY",
	"VE",
	"VN",
	"ZA",
] as const

/**
 * GeoNames alias-fold tail (synthetic ids @ 9e12): bilingual/alt-name coverage for the remaining locales.
 */
export const DEFAULT_GEONAMES_COUNTRIES = [
	"AD",
	"AF",
	"AG",
	"AI",
	"AL",
	"AM",
	"AS",
	"AT",
	"AW",
	"AX",
	"AZ",
	"BA",
	"BB",
	"BE",
	"BF",
	"BI",
	"BJ",
	"BL",
	"BM",
	"BN",
	"BQ",
	"BS",
	"BT",
	"BW",
	"BZ",
	"CC",
	"CD",
	"CF",
	"CG",
	"CH",
	"CK",
	"CV",
	"CW",
	"CX",
	"CY",
	"CZ",
	"DJ",
	"DK",
	"DM",
	"EH",
	"ER",
	"FI",
	"FJ",
	"FK",
	"FM",
	"FO",
	"GA",
	"GD",
	"GE",
	"GF",
	"GG",
	"GI",
	"GL",
	"GM",
	"GN",
	"GP",
	"GQ",
	"GS",
	"GU",
	"GW",
	"GY",
	"HK",
	"HN",
	"HR",
	"HT",
	"IM",
	"JE",
	"JM",
	"KG",
	"KI",
	"KM",
	"KN",
	"KP",
	"KY",
	"LA",
	"LC",
	"LI",
	"LR",
	"LS",
	"LT",
	"LU",
	"LV",
	"LY",
	"MC",
	"MD",
	"ME",
	"MF",
	"MG",
	"MH",
	"MK",
	"ML",
	"MN",
	"MO",
	"MP",
	"MQ",
	"MR",
	"MS",
	"MT",
	"MU",
	"MV",
	"MW",
	"MZ",
	"NA",
	"NC",
	"NE",
	"NF",
	"NI",
	"NO",
	"NR",
	"NU",
	"PF",
	"PG",
	"PL",
	"PM",
	"PN",
	"PR",
	"PS",
	"PW",
	"PY",
	"RE",
	"RW",
	"SB",
	"SC",
	"SD",
	"SH",
	"SI",
	"SJ",
	"SK",
	"SL",
	"SM",
	"SO",
	"SR",
	"SS",
	"ST",
	"SV",
	"SX",
	"SY",
	"SZ",
	"TC",
	"TD",
	"TF",
	"TG",
	"TJ",
	"TL",
	"TM",
	"TO",
	"TT",
	"TV",
	"UZ",
	"VA",
	"VC",
	"VG",
	"VI",
	"VU",
	"WF",
	"WS",
	"XK",
	"YE",
	"YT",
	"ZM",
	"ZW",
] as const

/**
 * Pinned Overture release for the divisions theme. Rows churn between monthly releases, and two
 * vintages must never mix inside one artifact.
 *
 * Overture deletes old releases, so a pin survives on the order of a month and then the build fails
 * with `No files found that match the pattern`.
 *
 * Keep this equal to `poi/defaults.ts`'s `DEFAULT_RELEASE`.
 */
export const DEFAULT_OVERTURE_RELEASE = "2026-07-22.0"

/**
 * Staging suffix for admin rebuilds. Build here, verify, then swap over the live name (releasing.md).
 */
export const DEFAULT_ADMIN_STAGING_SUFFIX = ".REBUILD.db"

/**
 * The zero-coverage gap set: GeoNames-alias locales carrying no WOF or Overture admin.
 *
 * These are the `adminForCountries` targets for the GeoNames fold. Without the A-class fold
 * (pcli country + ADM1 regions + locality ancestry linking), their localities are orphans and
 * "City, Country" scoping breaks. Countries with WOF/Overture admin are excluded by construction,
 * because folding their GeoNames admin would double up.
 */
export function geonamesAdminGapCountries(): string[] {
	const covered = new Set<string>([...DEFAULT_OVERTURE_COUNTRIES, ...DEFAULT_WOF_PRIORITY_COUNTRIES])

	return DEFAULT_GEONAMES_COUNTRIES.filter((cc) => !covered.has(cc))
}

/**
 * The country set a standalone fold re-derives.
 *
 * It is the same recipe `buildAdmin` bakes into the admin artifact ({@link DEFAULT_GEONAMES_COUNTRIES}),
 * because the fold rewrites its whole id range, and a narrower list re-folds the front of
 * that range while other countries' name rows stay attached to the wrong places.
 */
export const DEFAULT_FOLD_COUNTRIES = DEFAULT_GEONAMES_COUNTRIES

/**
 * The conventional candidate-build output.
 */
export const DEFAULT_CANDIDATE_OUT = "candidate-global.db"

/**
 * The conventional admin source the fold copies from.
 */
export const DEFAULT_ADMIN_DB = "admin-global-priority.db"

/**
 * The conventional source of the `importance` column, a WOF admin database carrying
 * `place_importance`, built by `mailwoman gazetteer importance`.
 *
 * Deliberately a separate artifact from {@link DEFAULT_ADMIN_DB}: the scores are expensive to derive
 * and change on their own cadence, so the candidate build joins them in by name rather than
 * assuming one file holds both.
 */
export const DEFAULT_IMPORTANCE_DB = "admin-global-priority-importance.db"

/**
 * The tail database's country set, in the frozen artifact's ingest order.
 *
 * Any change here re-freezes the artifact: rebuild, run the parity check against the previous
 * database, and rotate via the .prev workflow. The first ten entries are order-critical and every
 * later country must be appended, because ids are positional in ingest order and inserting a country
 * shifts every following id. The parity check validates ids as well as counts for this reason.
 *
 * Prefer counts at resolver granularity. GeoNames postal publishes one row per (postcode, settlement)
 * and duplicates some hyphenated formats, so raw row totals overstate distinct codes.
 */
export const DEFAULT_GEONAMES_TAIL_COUNTRIES = [
	"FI",
	"CZ",
	"SK",
	"SI",
	"DK",
	"NO",
	"HR",
	"PL",
	"SE",
	"BE",
	"AD",
	// AE is deliberately absent. GeoNames publishes 178,171 rows for it, every one a `nnnnn nnnnn`
	// pair at Dubai-area coordinates, and those are Makani building codes rather than postcodes.
	// The United Arab Emirates has no postal code system and mail goes to PO boxes, so ingesting
	// these as `placetype = 'postalcode'` would claim 178,171 postcodes for a country with none and
	// every coverage figure taken from that tier would inherit the claim.
	//
	// The lookup itself would match, because the name law strips non-alphanumerics, so `28119 95762`
	// keys as `2811995762`. These belong in a building tier, a rooftop-grade geocode with a
	// coordinate per building.
	"AI",
	"AL",
	"AR",
	"AX",
	"AZ",
	"BD",
	"BG",
	"BM",
	"BR",
	"BY",
	"CC",
	"CL",
	"CN",
	"CO",
	"CR",
	"CX",
	"CY",
	"DO",
	"DZ",
	"EC",
	"EE",
	"FK",
	"FM",
	"FO",
	"GF",
	"GG",
	"GI",
	"GL",
	"GP",
	"GS",
	"GT",
	"GU",
	"HK",
	"HM",
	"HN",
	"HT",
	"HU",
	"ID",
	"IE",
	"IM",
	"IN",
	"IO",
	"IS",
	"JE",
	"KE",
	"KR",
	"LI",
	"LK",
	"MA",
	"MC",
	"MD",
	"MH",
	"MK",
	"MO",
	"MP",
	"MQ",
	"MT",
	"MW",
	"MX",
	"MY",
	"NC",
	"NF",
	"NR",
	"NU",
	"NZ",
	"PA",
	"PE",
	"PF",
	"PH",
	"PK",
	"PM",
	"PN",
	"PR",
	"PW",
	"RE",
	"RO",
	"RS",
	"RU",
	"SJ",
	"SM",
	"TC",
	"TH",
	"TR",
	"UA",
	"UY",
	"VA",
	"VI",
	"WF",
	"WS",
	"YT",
	"ZA",
] as const

/**
 * Default parent-coverage floor for crediting a sub-locality rung.
 *
 * This is the weakest number in the design and is deliberately a parameter. GB is the one country
 * with a validated reading at around 33%, so 5% sits far below that calibration point.
 *
 * It is set low on purpose, to catch thin-but-real tiers rather than to certify them.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.05
