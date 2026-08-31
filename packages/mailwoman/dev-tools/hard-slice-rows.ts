/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The hard-slice board's FRAGMENT-REGISTER rows — inputs whose difficulty is their SHAPE.
 *
 *   Split out of `build-hard-slice-board.run.ts` because the two halves change for different reasons and
 *   at different rates: the builder is implementation (read a WOF point, walk two FST binaries, emit JSONL),
 *   while this file is the editorial content — which inputs pin which discrimination case, and why. A row
 *   here carries NO coordinates and NO bias numbers on purpose; those are measured at build time from
 *   primary data, so the only thing a curator can get wrong is the CHOICE, which is the thing worth
 *   reviewing.
 *
 *   `comma_free` is the register the FST prior was designed for: a two-toponym fragment with no
 *   punctuation to segment it. `comma_control` is its twin with the comma restored — same truth, same
 *   expected place — so a move on one and not the other localizes the effect to the missing
 *   punctuation rather than to the toponym. The toponym-ambiguity half of the board lives in
 *   `hard-slice-rows-toponym.ts`; both are concatenated by the builder.
 *
 *   Every entry's `note` is the row's justification and ends up verbatim in the emitted board.
 */

import type { HardSliceClass } from "#eval-harness/hard-slice-board"

/**
 * A curated row before its numbers are filled in. `expectID` is a WOF place id; the builder reads the point.
 */
export interface Curated {
	id: string
	input: string
	locale: string
	country: string
	class: HardSliceClass
	probeSurface: string
	probeTag?: string
	expectID?: number
	toleranceM?: number
	bugRef?: string
	note: string
}

/**
 * Metro-scale bar for an admin-centroid answer — the sweep's `APPROXIMATE` tier.
 */
export const ADMIN_TOL = 25_000

/**
 * Tighter bar where the expected place is a specific municipality the resolver should hit squarely.
 */
export const CITY_TOL = 15_000

/**
 * The fragment-register rows: `comma_free` and its `comma_control` twins, US / FR / GB / DE. Each entry's `note` is its
 * justification and ships verbatim in the emitted board.
 */
export const FRAGMENT_ROWS: Curated[] = [
	//#region comma_free
	// The FST prior's design register: a two-toponym fragment with NO punctuation. Each is paired with its
	// `comma_control` twin below — same truth, comma restored. A `comma_free` row that moves while its
	// control does not is the bias acting exactly where it was designed to.
	{
		id: "us-cf-moscow-idaho",
		input: "Moscow Idaho",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Moscow",
		expectID: 85_937_727,
		toleranceM: CITY_TOL,
		note: "Bare comma-free namesake. 'Moscow' is a US locality (Idaho, pop 26,387) whose global namesake dwarfs it; the population arm scores the surface 0.34, the importance arm 0.55.",
	},
	{
		id: "us-cf-paris-texas",
		input: "Paris Texas",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Paris",
		expectID: 101_725_293,
		toleranceM: CITY_TOL,
		bugRef: "#905",
		note: "The #905 namesake lineage in comma-free form. Paris TX (pop 24,969) against Paris FR — the classic case the bare-form ranking work pinned.",
	},
	{
		id: "us-cf-berlin-wisconsin",
		input: "Berlin Wisconsin",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Berlin",
		expectID: 101_732_851,
		toleranceM: CITY_TOL,
		note: "Berlin WI (pop 5,559). One of the larger US bias deltas (0.24 → 0.49) on a surface whose foreign namesake is a capital.",
	},
	{
		id: "us-cf-stanley-north-dakota",
		input: "Stanley North Dakota",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Stanley",
		expectID: 85_981_981,
		toleranceM: CITY_TOL,
		note: "Family-C surname/toponym collision — 'Stanley' is also a given name and a Falklands capital (the sweep's fk-cs-stanley). Bias 0.17 → 0.47.",
	},
	{
		id: "us-cf-victoria-texas",
		input: "Victoria Texas",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Victoria",
		expectID: 101_724_833,
		toleranceM: CITY_TOL,
		note: "Family-C: 'Victoria' names a monarch, a Canadian capital, and the Seychelles capital (sweep sc-cs-victoria).",
	},
	{
		id: "us-cf-athens-georgia",
		input: "Athens Georgia",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Athens",
		expectID: 85_936_177,
		toleranceM: CITY_TOL,
		bugRef: "#1023",
		note: "Doubly confounded — the toponym is a foreign capital AND the region token 'Georgia' is a country name (the #1023 class), with no comma to separate them.",
	},
	{
		id: "us-cf-lebanon-tennessee",
		input: "Lebanon Tennessee",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Lebanon",
		expectID: 101_723_075,
		toleranceM: CITY_TOL,
		bugRef: "#1023",
		note: "The #1023 sibling in comma-free form: 'Lebanon' parses as a country, so the fragment must survive without the explicit-country coherence path the comma form rides.",
	},
	{
		id: "us-cf-freeport-illinois",
		input: "Freeport Illinois",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Freeport",
		expectID: 85_940_617,
		toleranceM: CITY_TOL,
		note: "Sweep bs-cs-freeport's US twin (Bahamas Freeport was 1,637 km off). Bias 0.39 → 0.54.",
	},
	{
		id: "us-cf-hamilton-ohio",
		input: "Hamilton Ohio",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Hamilton",
		expectID: 101_712_657,
		toleranceM: CITY_TOL,
		note: "120 US bearers plus Bermuda's capital (sweep bm-cs-hamilton) and New Zealand's — the highest-fan-out surname/toponym on the board.",
	},
	{
		id: "us-cf-dublin-california",
		input: "Dublin California",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Dublin",
		expectID: 85_921_909,
		toleranceM: CITY_TOL,
		bugRef: "#905",
		note: "The #905 'global-dublin-bare' surface, pointed the other way: the US bearer must win when a US region follows it with no comma.",
	},
	{
		id: "us-cf-naples-florida",
		input: "Naples Florida",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Naples",
		expectID: 85_931_799,
		toleranceM: CITY_TOL,
		note: "Exonym namesake (Napoli). Bias 0.32 → 0.54.",
	},
	{
		id: "us-cf-vienna-virginia",
		input: "Vienna Virginia",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Vienna",
		expectID: 101_729_035,
		toleranceM: CITY_TOL,
		bugRef: "#822",
		note: "#822's surface without its comma: six populous US Viennas against the Austrian capital.",
	},
	{
		id: "us-cf-memphis-tennessee",
		input: "Memphis Tennessee",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Memphis",
		expectID: 101_722_645,
		toleranceM: CITY_TOL,
		note: "Dominant-bearer control inside the comma-free class: Memphis TN is 69x the next US bearer, so a failure here is the FRAGMENT SHAPE failing, not the ranking.",
	},
	{
		id: "us-cf-toledo-ohio",
		input: "Toledo Ohio",
		locale: "en-us",
		country: "US",
		class: "comma_free",
		probeSurface: "Toledo",
		expectID: 101_712_039,
		toleranceM: CITY_TOL,
		note: "Spanish exonym namesake with a dominant US bearer (pop 265,304).",
	},
	{
		id: "gb-cf-preston-lancashire",
		input: "Preston Lancashire",
		locale: "en-gb",
		country: "GB",
		class: "comma_free",
		probeSurface: "Preston",
		expectID: 101_750_593,
		toleranceM: CITY_TOL,
		note: "GB comma-free. 19 bearers in the GB FST; the Lancashire city (pop 141,801) must beat the East Riding village (pop 3,364).",
	},
	{
		id: "gb-cf-richmond-north-yorkshire",
		input: "Richmond North Yorkshire",
		locale: "en-gb",
		country: "GB",
		class: "comma_free",
		probeSurface: "Richmond",
		expectID: 101_873_301,
		toleranceM: CITY_TOL,
		note: "The GB surface with the largest measured bias delta (0.23 → 0.52) — Richmond upon Thames is far more populous, so the trailing region is the ONLY disambiguator and it carries no comma.",
	},
	{
		id: "fr-cf-saint-denis-seine-saint-denis",
		input: "Saint-Denis Seine-Saint-Denis",
		locale: "fr-fr",
		country: "FR",
		class: "comma_free",
		probeSurface: "Saint-Denis",
		expectID: 101_751_155,
		toleranceM: CITY_TOL,
		note: "The §2 canonical pair in comma-free form — and the department name REPEATS the toponym, so a greedy locality span swallows its own disambiguator.",
	},
	{
		id: "de-cf-weimar-thueringen",
		input: "Weimar Thüringen",
		locale: "de-de",
		country: "DE",
		class: "comma_free",
		probeSurface: "Weimar",
		expectID: 101_748_623,
		toleranceM: CITY_TOL,
		note: "DE comma-free. Weimar's encyclopedic weight far exceeds its size (pop 65,228) — bias 0.43 → 0.67, the archetype of the two-score split.",
	},
	//#endregion

	//#region comma_control
	// The byte-stability twins. These must NOT be where an arm earns its score.
	{
		id: "us-cc-moscow-idaho",
		input: "Moscow, Idaho",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Moscow",
		expectID: 85_937_727,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-moscow-idaho. The punctuation already segments the fragment, so the gazetteer prior should be redundant here.",
	},
	{
		id: "us-cc-paris-texas",
		input: "Paris, Texas",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Paris",
		expectID: 101_725_293,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-paris-texas.",
	},
	{
		id: "us-cc-berlin-wisconsin",
		input: "Berlin, Wisconsin",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Berlin",
		expectID: 101_732_851,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-berlin-wisconsin.",
	},
	{
		id: "us-cc-stanley-north-dakota",
		input: "Stanley, North Dakota",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Stanley",
		expectID: 85_981_981,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-stanley-north-dakota.",
	},
	{
		id: "us-cc-victoria-texas",
		input: "Victoria, Texas",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Victoria",
		expectID: 101_724_833,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-victoria-texas.",
	},
	{
		id: "us-cc-athens-georgia",
		input: "Athens, Georgia",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Athens",
		expectID: 85_936_177,
		toleranceM: CITY_TOL,
		bugRef: "#1023",
		note: "Comma control for us-cf-athens-georgia.",
	},
	{
		id: "us-cc-lebanon-tennessee",
		input: "Lebanon, Tennessee",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Lebanon",
		expectID: 101_723_075,
		toleranceM: CITY_TOL,
		bugRef: "#1023",
		note: "Comma control for us-cf-lebanon-tennessee.",
	},
	{
		id: "us-cc-hamilton-ohio",
		input: "Hamilton, Ohio",
		locale: "en-us",
		country: "US",
		class: "comma_control",
		probeSurface: "Hamilton",
		expectID: 101_712_657,
		toleranceM: CITY_TOL,
		note: "Comma control for us-cf-hamilton-ohio.",
	},
	{
		id: "gb-cc-preston-lancashire",
		input: "Preston, Lancashire",
		locale: "en-gb",
		country: "GB",
		class: "comma_control",
		probeSurface: "Preston",
		expectID: 101_750_593,
		toleranceM: CITY_TOL,
		note: "Comma control for gb-cf-preston-lancashire.",
	},
	{
		id: "fr-cc-saint-denis-seine-saint-denis",
		input: "Saint-Denis, Seine-Saint-Denis",
		locale: "fr-fr",
		country: "FR",
		class: "comma_control",
		probeSurface: "Saint-Denis",
		expectID: 101_751_155,
		toleranceM: CITY_TOL,
		note: "Comma control for fr-cf-saint-denis-seine-saint-denis.",
	},
	{
		id: "de-cc-weimar-thueringen",
		input: "Weimar, Thüringen",
		locale: "de-de",
		country: "DE",
		class: "comma_control",
		probeSurface: "Weimar",
		expectID: 101_748_623,
		toleranceM: CITY_TOL,
		note: "Comma control for de-cf-weimar-thueringen.",
	},
	//#endregion
]
