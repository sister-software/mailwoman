/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The canonical admin-gazetteer coverage recipe — the durable replacement for reconstruct-from-artifact
 *   (#1015: the manifest lagged the live DB by 71 Overture + 161 GeoNames countries, and the recipe had to
 *   be recovered from the artifact's synthetic-id ranges). The recipe now lives here, reviewed like code;
 *   `data/gazetteer/wof-build-manifest.json` is a build LOG (what ran, when, md5), not a recipe store.
 *
 *   Provenance of the lists: reconstructed 2026-07-07 from the live `admin-global-priority.db` — WOF rows
 *   (`id < 2e9`) → the priority countries. Overture divisions (`8e12 ≤ id < 9e12`) → the 86. the GeoNames
 *   alias fold (`id ≥ 9e12`) → the 161. See releasing.md "Rebuilding + swapping the canonical admin
 *   gazetteer" and the #1021 PR.
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
	// Added 2026-08-02 after the granularity probe.
	// `whosonfirst-data-admin-in` carries 189,026 sub-locality nodes — more than Germany's
	// 67,162, the richest tier shipped before this — converting at 98.6% into 186,469
	// (child, parent) pairs, against Overture-IN's 74,920 nodes.
	// That is 6× the shipped GB pair index, which took eight campaign rungs to assemble.
	// IN moves OUT of DEFAULT_OVERTURE_COUNTRIES in the same change: a country served
	// by both would double up its admin (the #267 warning).
	"IN",
	"IT",
	"JP",
	"KR",
	"NL",
	"TW",
	"US",
] as const

/**
 * Overture `divisions`-theme backfill set (synthetic ids @ 8e12) — the zero-WOF-repo locales.
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
	// "IN" moved to DEFAULT_WOF_PRIORITY_COUNTRIES 2026-08-02 — see the note there.
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
 * GeoNames alias-fold tail (synthetic ids @ 9e12) — bilingual/alt-name coverage for the remaining locales.
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
 * Pinned Overture release for the divisions theme (rows churn between monthly releases. Never mix two).
 *
 * Overture deletes old releases.
 * The bucket held exactly two when this was last checked, so a pin survives on the order
 * of a month and then the build fails with `No files found that match the pattern`.
 *
 * Keep this equal to `poi/defaults.ts`'s `DEFAULT_RELEASE`: two pins drifting apart
 * is what left this one on a pruned release while POI moved, and mixing two vintages
 * inside one artifact is the thing the line above forbids.
 */
export const DEFAULT_OVERTURE_RELEASE = "2026-07-22.0"

/**
 * Staging suffix for admin rebuilds — build here, verify, then swap over the live name (releasing.md).
 */
export const DEFAULT_ADMIN_STAGING_SUFFIX = ".REBUILD.db"

/**
 * The zero-coverage gap set — GeoNames-alias locales carrying no WOF or Overture admin.
 *
 * These are the `adminForCountries` targets for the GeoNames fold (#267): without the A-class
 * fold (pcli country + ADM1 regions + locality ancestry linking), their localities are orphans
 * and "City, Country" scoping breaks (#1023/#1026 — the canonical recipe silently omitted this
 * until 2026-07-07. The country nodes had come from coverage-expansion runs outside the recipe).
 * Countries with WOF/Overture admin are excluded by construction — folding their
 * GeoNames admin would double up (the #267 warning).
 */
export function geonamesAdminGapCountries(): string[] {
	const covered = new Set<string>([...DEFAULT_OVERTURE_COUNTRIES, ...DEFAULT_WOF_PRIORITY_COUNTRIES])

	return DEFAULT_GEONAMES_COUNTRIES.filter((cc) => !covered.has(cc))
}

/**
 * The country set a standalone fold re-derives.
 *
 * The same recipe `buildAdmin` bakes into the admin artifact ({@link DEFAULT_GEONAMES_COUNTRIES}),
 * because the fold rewrites its whole id range and any narrower list drops the difference (#1514).
 *
 * It used to be the 14-country bilingual EU set this fold was born for
 * (#743/#193 — FI hard-resolve 69.5 → 85.8 %), from when the fold was a separate step run against
 * an unfolded admin. #1027 moved the fold inside `buildAdmin` and widened it to 161 countries.
 * The 14-country default outlived that and became the payload of the 2026-08-05 incident,
 * re-folding 212,993 places over the front of a 774,338-place range and leaving the rest
 * of the world's names attached to Austrian, Swiss and Lithuanian villages.
 */
export const DEFAULT_FOLD_COUNTRIES = DEFAULT_GEONAMES_COUNTRIES

/**
 * The conventional candidate-build output.
 */
export const DEFAULT_CANDIDATE_OUT = "candidate-global.db"
/**
 * The conventional source of the `importance` column (#28) — a WOF admin database
 * carrying `place_importance`, built by `mailwoman gazetteer importance`.
 *
 * Deliberately a separate artifact from {@link DEFAULT_ADMIN_DB}: the scores are expensive to derive
 * and change on their own cadence, so the shipped admin DB has never carried the table,
 * and the candidate build joins them in by name rather than assuming one file holds both.
 */
export const DEFAULT_IMPORTANCE_DB = "admin-global-priority-importance.db"

/**
 * The frozen artifact's ten countries, IN its ingest order
 * (recovered from its per-country `spr.id` ranges: FI @ 9500000000000 … GB @ 9500000056075).
 *
 * The first nine are the #920 namesake-tail set the original `--geonames-postal-countries` flag carried.
 * GB was appended in a later pass from the `GB_full` dump and is 97 % of the
 * artifact (1,839,678 of 1,895,753 rows, ~946 MB).
 *
 * Keep the order: it is what makes a rebuild id-comparable to the frozen database.
 */

/**
 * The tail database's country set, in the frozen artifact's ingest order.
 *
 * GB moved to Code-Point Open on 2026-08-05.
 * Belgium was added on 2026-08-12 (the eu-mixed lane).
 *
 * Any change here re-freezes the artifact: rebuild, run the parity check against
 * the previous database, and rotate via the .prev workflow.
 *
 * The first ten entries are order-critical.
 * All later countries must be appended.
 *
 * Ids are positional in ingest order, so inserting a country shifts every following id.
 *
 * The parity check validates ids as well as counts for this reason.
 *
 * Historically this tail started as ten countries from #920.
 * GeoNames publishes 121 countries, while the gazetteer had a postcode tier for 28.
 * The appended set adds the 93 with on-disk data and no tier.
 *
 * On rebuild this changed coverage from 10 to 103 countries and from 57,221 to 505,784 codes,
 * with no code loss and no id movement in the original ten.
 *
 * Prefer counts at resolver granularity.
 * GeoNames postal publishes one row per (postcode, settlement) and duplicates some
 * hyphenated formats, so raw row totals overstate distinct codes.
 * Across the appended 93, 938,543 rows fold to 448,563 codes.
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
	// AE is deliberately absent and is the largest single country GeoNames publishes here:
	// 178,171 rows, more than RU + RO + KR combined.
	// Every one is a `nnnnn nnnnn` pair at Dubai-area coordinates (lat 24.63–25.32, lon 54.91–56.20) —
	// Makani building codes rather than postcodes.
	// The United Arab Emirates has no postal code system.
	// Mail goes to PO boxes.
	// Ingesting them as `placetype = 'postalcode'` would claim 178,171 postcodes for a country
	// with none, and every coverage figure taken from that tier would inherit the claim.
	//
	// The lookup would have worked, which is why this would have shipped unnoticed:
	// the #920 name law strips non-alphanumerics.
	// Therefore, `28119 95762` keys as `2811995762` and matches a query typed the same way.
	// Correct behaviour under a wrong placetype is the hardest kind of wrong to see.
	//
	// These belong in a building tier rather than being dropped.
	// Makani is a rooftop-grade geocode with a coordinate per building (#2300).
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
 * This is the weakest number in the design and is deliberately a parameter.
 * GB — the one country with a validated reading — sits around 33%, so 5% is far
 * below the only calibration point we have.
 *
 * It is set low on purpose, to catch thin-but-real tiers rather than to certify them.
 * A second calibration point should harden it.
 */
export const DEFAULT_COVERAGE_FLOOR = 0.05
