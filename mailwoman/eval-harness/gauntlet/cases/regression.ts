/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The curated regression corpus, as committed/reviewable source (built into `gauntlet/regression.db` by
 *   `build-regression-db.ts`). DELIBERATELY SMALL — this is the executable bug log, NOT a comprehensive
 *   corpus. Every entry pins a real failure we fixed; the runner gates REGRESSION-ONLY against `status`.
 *   Add an entry whenever a bug is fixed; never pad it to feel "thorough" (that's curated-set capture).
 */

/* oxlint-disable max-lines -- 826 lines of flat seed cases (54 entries). The length IS the number of
   regressions guarded; splitting it by country would scramble the chronological entry numbering the
   comments reference, and buy no legibility — nothing here is control flow. */

import type { AddressKind, CaseStatus, ResolutionTier } from "../schema.ts"

export interface SeedCase {
	id: string
	input: string
	source: string
	addressKind: AddressKind
	country: string
	status: CaseStatus
	/**
	 * Asserted admin/parse fields, when relevant — `{ country?, region?, locality? }` (matched case-insensitively).
	 */
	expectComponents?: Record<string, string>
	/**
	 * Optional resolver country prior (ISO-3166 alpha-2), forwarded as geocodeAddress's `defaultCountry`.
	 */
	defaultCountry?: string
	expectPlaceID?: string
	expectPlaceName?: string
	expectLat?: number
	expectLon?: number
	/**
	 * Great-circle tolerance (m). Defaults at runtime when absent.
	 */
	expectToleranceM?: number
	expectTier?: ResolutionTier
	addedAt: string
	bugRef?: string
	note?: string
}

/**
 * Seed cases for the regression leg — each is a parse that broke once, kept so it cannot break again.
 */
export const REGRESSION_CASES: SeedCase[] = [
	{
		// Entry #1 — the FR OSM rooftop tier + the v1.9.4 parse fix, guarded via the WITH-postcode demo form.
		id: "fr-chevaleret-rooftop",
		input: "181 Rue du Chevaleret, 75013 Paris",
		source: "bug:#828",
		addressKind: "fr_street",
		country: "FR",
		status: "pass",
		expectLat: 48.8335023,
		expectLon: 2.3686051,
		expectToleranceM: 80,
		expectTier: "address_point",
		addedAt: "2026-06-29",
		bugRef: "#251 / #828",
		note: "FR street → OSM rooftop. v1.9.4 parse fix (postcode-anchoring) + the OSM FR rooftop tier (D9).",
	},
	{
		// #831 FIXED — promoted to a gated pass (night 34, 2026-07-05). The v5.4.0 parse fix
		// (v2.3.0-nl-postcode, family-pinned) parses 'Chevaleret' into the street ('Rue du Chevaleret'),
		// not the locality, so the canonical mixed-case now reaches the OSM rooftop tier — verified
		// deterministic at 48.8335,2.3686 (address_point) under the shipped v5.4.0 dev weights. Not a
		// #829 effect (that hook only touches all-lowercase input; the mixed-case canonical is untouched).
		id: "fr-chevaleret-bare",
		input: "181 Rue du Chevaleret, Paris",
		source: "bug:#831",
		addressKind: "fr_street_bare",
		country: "FR",
		status: "pass",
		expectLat: 48.8335023,
		expectLon: 2.3686051,
		expectToleranceM: 80,
		expectTier: "address_point",
		addedAt: "2026-06-29",
		bugRef: "#831",
		note: "Bare no-postcode FR street → OSM rooftop. v5.4.0 parse fix reaches the street tier (was: 'Chevaleret'→locality→arrondissement centroid). Promoted from known_fail once the canonical hit rooftop deterministically.",
	},
	{
		// A US landmark anchor — guards the US admin/street path doesn't drift while we touch intl. (country
		// is dropped: the US resolver hierarchy stops at region — region=DC already implies US.)
		id: "us-dc-pennsylvania",
		input: "1600 Pennsylvania Ave NW, Washington DC",
		source: "golden",
		addressKind: "us_landmark",
		country: "US",
		status: "pass",
		expectComponents: { region: "DC", locality: "Washington" },
		expectLat: 38.8977,
		expectLon: -77.0365,
		expectToleranceM: 1500,
		addedAt: "2026-06-29",
		note: "Well-known US address; anchors that the US path stays put across intl changes.",
	},
	{
		// The 'Ave recovered as a French locality' span-rescore bug (66ff2e68). The fix's guarantee is IN NY,
		// NOT France — guarded with a wide (NY-state) tolerance. The tighter NYC disambiguation is #832.
		id: "us-5th-ave-ny-rescore",
		input: "350 5th Ave, New York, NY",
		source: "bug:span-rescore",
		addressKind: "us_street_ambiguous",
		country: "US",
		status: "pass",
		expectComponents: { region: "NY", locality: "New York" },
		expectLat: 40.74858,
		expectLon: -73.98526,
		expectToleranceM: 500_000,
		addedAt: "2026-06-29",
		bugRef: "span-rescore confidentRanges (street affix); NYC disambiguation = #832",
		note: "Pre-fix the span-rescore recovered 'Ave' as a same-named French locality (48.57,0.28). Guards IN NY not France; currently lands upstate NY not NYC (#832).",
	},
	{
		// #832 — RESOLVED. NYC carries WOF parent_id=-4 (multi-parent sentinel), so the ancestors parent_id
		// closure left it only-self; the region hard-filter then excluded it and "New York Mills" (pop 3,190)
		// won over NYC (8.8M). Fixed by wiring the wof:hierarchy ancestry backfill into the build (PR #835) +
		// swapping the backfilled canonical DB. Gated `pass` so it can't silently regress (anti-rot).
		id: "us-new-york-nyc",
		input: "New York, NY",
		source: "bug:#832",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "NY", locality: "New York" },
		expectLat: 40.6945,
		expectLon: -73.9304,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		bugRef: "#832",
		note: "Was: 'New York, NY' → New York Mills (upstate, 43.10). Root cause was NOT the FTS window (NYC was in it) — it was NYC's broken ancestry (parent_id=-4). Fixed via the wof:hierarchy ancestry backfill.",
	},
	{
		// #833 — RESOLVED by admin descendant-consistency (#263). The greedy walk resolved region "ME" to
		// Messina (IT, by population), "Portland" found nothing under it, and the result fell back to the
		// Sicilian centroid. The fix re-picks the (region, locality) pair where the locality descends from a
		// same-named region candidate — Portland descends from Maine, not Messina. No country prior, no list.
		id: "us-portland-me",
		input: "Portland, ME",
		source: "bug:#833",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "ME", locality: "Portland" },
		expectLat: 43.647,
		expectLon: -70.168,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		bugRef: "#833",
		note: "Was Messina, Italy. Fixed by joint-consistency (adminCoherence) — Portland descends from Maine, not Messina. Earlier deterministic country-prior patch shelved; this is the structural fix.",
	},
	{
		// #833 sibling — a different namesake collision (region "OR" → Ourense, Spain), guards that the fix
		// generalizes across countries (IT for ME, ES for OR), not just one province.
		id: "us-portland-or",
		input: "Portland, OR",
		source: "bug:#833",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "OR", locality: "Portland" },
		expectLat: 45.537,
		expectLon: -122.65,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		bugRef: "#833",
		note: "Was Ourense, Spain ('OR' province). Fixed by adminCoherence — Portland descends from Oregon. Guards the country-agnostic generalization of the joint-consistency fix.",
	},
	{
		// #833 two-pairs residual — "Augusta" exists under BOTH Maine and Messina (IT), so the locality
		// resolves under the greedy foreign region and adminCoherence's unresolved-trigger never fires.
		// Closed by the forward `country_hint` linkage: a 2-letter US-state abbrev pins the region to US.
		id: "us-augusta-me",
		input: "Augusta, ME",
		source: "bug:#833",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "ME", locality: "Augusta" },
		expectLat: 44.31,
		expectLon: -69.78,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		bugRef: "#833",
		note: "Was Augusta, Sicily — the two-consistent-pairs case (Augusta under both Maine and Messina). Fixed by the abbrev-only country_hint forward linkage (recognizeUSRegions → resolver country=US), not the descendant-consistency pass.",
	},
	{
		// A clean US 'City, ST' that resolves correctly — guards the working path so a placer/ranking change
		// for #832/#833 can't silently regress it. Springfield-IL is also a tuned exact-match case.
		id: "us-springfield-il",
		input: "Springfield, IL",
		source: "golden",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "IL", locality: "Springfield" },
		expectLat: 39.7817,
		expectLon: -89.6501,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		note: "Tuned exact-match case (2026-05-30-resolver-exact-match.md). Guards the working bare-City-ST path.",
	},
	{
		id: "us-chicago-il",
		input: "Chicago, IL",
		source: "golden",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "IL", locality: "Chicago" },
		expectLat: 41.8781,
		expectLon: -87.6298,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		note: "A large unambiguous US city — guards the working bare-City-ST path.",
	},
	{
		// #266/#267 — international coverage. "Georgia" the country shadows the populous US state; the GeoNames
		// admin fold (#267 data) + the country-candidate reconcile (#267 resolver) land Tbilisi in Georgia, not
		// US Georgia. Guards the gap-country admin hierarchy + the foreign-capital-vs-US-state collision fix.
		id: "intl-tbilisi-georgia",
		input: "Tbilisi, Georgia",
		source: "bug:#267",
		addressKind: "intl_city_country",
		country: "GE",
		status: "pass",
		expectComponents: { locality: "Tbilisi" },
		expectLat: 41.6938,
		expectLon: 44.8015,
		expectToleranceM: 25_000,
		addedAt: "2026-06-29",
		bugRef: "#266 / #267",
		note: "Was US Georgia (32.6,-83.4). Fixed by the #267 GeoNames admin fold (Tbilisi > K'alak'i T'bilisi > Georgia) + reconcileAdminPair's country-candidate fall-through (a foreign capital under its country out-votes the US-state namesake).",
	},
	{
		// #1023 — a SECOND Georgian city on the exact path the Tbilisi fix repairs. "Georgia" parses as
		// `region` (it names a US state), so a non-capital Georgian city ("Batumi") must ride
		// reconcileAdminPair's matchCountry fall-through, NOT the greedy walk. Guards against a future admin
		// rebuild re-breaking the country-vs-US-state class for anything but the one capital already pinned.
		id: "intl-batumi-georgia",
		input: "Batumi, Georgia",
		source: "bug:#1023",
		addressKind: "intl_city_country",
		country: "GE",
		status: "pass",
		expectComponents: { locality: "Batumi" },
		expectLat: 41.6168,
		expectLon: 41.6367,
		expectToleranceM: 25_000,
		addedAt: "2026-07-07",
		bugRef: "#1023",
		note: "Was US Georgia after the 2026-07-07 admin rebuild (#1015) flattened GE to localities-only (no country node; Tbilisi/Batumi orphaned, parent_id -1) — the country-node + parentID fall-through could no longer reach the Georgian city. Fixed by reconcileAdminPair's matchCountry fall-through (#1023): the token → ISO-3166 GE, then scope the locality by the gazetteer's `country` COLUMN.",
	},
	{
		// #1023 byte-stability guard (the NEGATIVE case) — a DOMESTIC "City, Georgia" (US) must stay US
		// Georgia. The matchCountry fall-through must never re-pick a real US city to a foreign namesake:
		// Savannah resolves under the US state in the greedy walk, so reconcileAdminPair's unresolved-locality
		// branch never fires. Pins that the #1023 fix doesn't over-reach into the domestic path.
		id: "us-savannah-georgia",
		input: "Savannah, Georgia",
		source: "bug:#1023",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "Georgia", locality: "Savannah" },
		expectLat: 32.0809,
		expectLon: -81.0912,
		expectToleranceM: 25_000,
		addedAt: "2026-07-07",
		bugRef: "#1023",
		note: "Guards that the #1023 matchCountry fall-through stays inert on a domestic pair — Savannah GA must NOT flip to Georgia the country. Resolves in the walk (locality never falls through), so the coherence pass is untouched.",
	},
	{
		// #1023 sibling-path guard — the country-vs-US-town namesake via the EXPLICIT-country path (#822),
		// the disjoint half of the namesake family. "Lebanon" parses as `country` (region=null), so
		// "Beirut, Lebanon" rides applyExplicitCountryCoherence, not reconcileAdminPair. Broadens the class
		// beyond Georgia (Lebanon has populous US-town namesakes — Lebanon PA/TN/OH) so a regression in
		// EITHER coherence pass is caught.
		id: "intl-beirut-lebanon",
		input: "Beirut, Lebanon",
		source: "bug:#1023",
		addressKind: "intl_city_country",
		country: "LB",
		status: "pass",
		expectComponents: { locality: "Beirut" },
		expectLat: 33.8938,
		expectLon: 35.5018,
		expectToleranceM: 25_000,
		addedAt: "2026-07-07",
		bugRef: "#1023",
		note: "The explicit-country coherence sibling of the region-parsed Tbilisi case — the resolved coordinate must stay in LB, not a US Lebanon namesake. Broadens the namesake guard beyond the Georgia collision.",
	},
	{
		// #822 — the named-foreign-country namesake. "Vienna" has 6 populous US namesakes that win the
		// population-first candidate window; the explicit "Austria" token was ignored. applyExplicitCountry
		// coherence (resolve.ts) re-picks the locality to the same-named place under matchCountry("Austria")=AT.
		id: "intl-vienna-austria",
		input: "Vienna, Austria",
		source: "bug:#822",
		addressKind: "intl_city_country",
		country: "AT",
		status: "pass",
		expectComponents: { locality: "Vienna" },
		expectLat: 48.2083,
		expectLon: 16.3725,
		expectToleranceM: 25_000,
		addedAt: "2026-06-30",
		bugRef: "#822",
		note: "Was Vienna WV (39.32,-81.54). The country was correctly PARSED as `country` but ignored by the population-first greedy walk; the explicit-country reconcile fixes it with no list — the country code comes from the parser's own emission via codex's ISO-3166 table.",
	},
	{
		// #822 — sibling case, the resolved-but-foreign path (the greedy walk picked a non-AU Sydney).
		id: "intl-sydney-australia",
		input: "Sydney, Australia",
		source: "bug:#822",
		addressKind: "intl_city_country",
		country: "AU",
		status: "pass",
		expectComponents: { locality: "Sydney" },
		expectLat: -33.8696,
		expectLon: 151.2094,
		expectToleranceM: 25_000,
		addedAt: "2026-06-30",
		bugRef: "#822",
		note: "Was a non-AU Sydney. Lat is negative (southern hemisphere) — guards the sign too.",
	},
	{
		// #822 — was Toronto OH (40.46,-80.61).
		id: "intl-toronto-canada",
		input: "Toronto, Canada",
		source: "bug:#822",
		addressKind: "intl_city_country",
		country: "CA",
		status: "pass",
		expectComponents: { locality: "Toronto" },
		expectLat: 43.6532,
		expectLon: -79.3832,
		expectToleranceM: 25_000,
		addedAt: "2026-06-30",
		bugRef: "#822",
		note: "Was Toronto OH. Toronto CA and the US namesakes share the western-hemisphere longitude sign, so this guards the magnitude, not just the sign.",
	},
	{
		// #822 — was Zurich KS (39.23,-99.43). The exonym is folded under the native "Zürich".
		id: "intl-zurich-switzerland",
		input: "Zurich, Switzerland",
		source: "bug:#822",
		addressKind: "intl_city_country",
		country: "CH",
		status: "pass",
		expectComponents: { locality: "Zurich" },
		expectLat: 47.3667,
		expectLon: 8.55,
		expectToleranceM: 25_000,
		addedAt: "2026-06-30",
		bugRef: "#822",
		note: "Was Zurich KS. Guards the exonym fold (Zurich → Zürich) under the country filter.",
	},
	{
		// #822 byte-stability guard — the explicit-country reconcile must NOT fire when a REGION scopes the
		// locality (no region/subregion ancestor between country and locality). "Springfield, IL, USA" must
		// stay Springfield IL, never the most-populous US Springfield. Pins the region guard in resolve.ts.
		id: "us-springfield-il-region-guard",
		input: "Springfield, IL, USA",
		source: "bug:#822",
		addressKind: "us_city_state",
		country: "US",
		status: "pass",
		expectComponents: { region: "IL", locality: "Springfield" },
		expectLat: 39.7817,
		expectLon: -89.6501,
		expectToleranceM: 25_000,
		addedAt: "2026-06-30",
		bugRef: "#822",
		note: "Region present ⇒ applyExplicitCountryCoherence skips ⇒ the region-scoped Springfield IL stands. Guards against the country filter coarsely re-picking the most-populous US Springfield.",
	},
	// #905 acceptance rows — bare famous namesakes through the production path. The Jun-27 GeoNames
	// alias fold silently broke unscoped ranking (FTS5 bm25 length-poisoning; the fix is the
	// population-ordered companion fetch + population-first exact tier, PR #910). These lock the
	// user-visible behavior class against BOTH ranking and placer regressions at the next DB rebuild —
	// the exact silent-break mode #905 documented (lab-only suites are CI-invisible).
	// STATUS 4/5 pass (#912 ranking bug CLOSED 2026-07-04): the #910 population-first exact tier +
	// #936 officialNameExact fixed both the library ranking AND the CLI defaultCountry/township-alias
	// path — Paris→FR, Dublin→IE, Melbourne→AU, Vancouver→CA all resolve correctly, and the #3
	// sub-finding ("Åbo"→"bo" diacritic drop) is gone. Åbo stays improvement_target for a DIFFERENT,
	// narrower reason: its coordinate is now correct (Turku) but the resolver returns the alias NAME
	// "Åbo" not canonical "Turku" (a name-canonicalization residual, #897 family) — see its note.
	{
		id: "global-paris-bare",
		input: "Paris",
		source: "bug:#905",
		addressKind: "bare_city_global",
		country: "FR",
		status: "pass",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8566,
		expectLon: 2.3522,
		expectToleranceM: 25_000,
		addedAt: "2026-07-02",
		bugRef: "#912",
		note: "Was Paris Township, Ohio post-alias-fold. The 2.19M-pop capital must beat 30k-pop namesakes when unscoped.",
	},
	{
		id: "global-dublin-bare",
		input: "Dublin",
		source: "bug:#905",
		addressKind: "bare_city_global",
		country: "IE",
		status: "pass",
		expectComponents: { locality: "Dublin" },
		expectLat: 53.3498,
		expectLon: -6.2603,
		expectToleranceM: 25_000,
		addedAt: "2026-07-02",
		bugRef: "#912",
		note: "Was Dublin, Ohio. Guards the class across countries (IE vs US namesakes).",
	},
	{
		id: "global-melbourne-bare",
		input: "Melbourne",
		source: "bug:#905",
		addressKind: "bare_city_global",
		country: "AU",
		status: "pass",
		expectComponents: { locality: "Melbourne" },
		expectLat: -37.8136,
		expectLon: 144.9631,
		expectToleranceM: 25_000,
		addedAt: "2026-07-02",
		bugRef: "#912",
		note: "Was Melbourne, Florida. Southern-hemisphere leg of the namesake class.",
	},
	{
		id: "global-vancouver-bare",
		input: "Vancouver",
		source: "bug:#905",
		addressKind: "bare_city_global",
		country: "CA",
		status: "pass",
		expectComponents: { locality: "Vancouver" },
		expectLat: 49.2827,
		expectLon: -123.1207,
		expectToleranceM: 25_000,
		addedAt: "2026-07-02",
		bugRef: "#912",
		note: "Was Vancouver, Washington (or Colombia mid-fix). The 3.4x-pop CA city must win unscoped.",
	},
	{
		id: "global-abo-alias",
		input: "Åbo",
		source: "bug:#905",
		addressKind: "bare_city_global",
		country: "FI",
		status: "improvement_target",
		expectComponents: { locality: "Turku" },
		expectLat: 60.4518,
		expectLon: 22.2666,
		expectToleranceM: 25_000,
		addedAt: "2026-07-02",
		bugRef: "#912",
		note: "COORDINATE FIXED (#910/#936, re-graded 2026-07-04): resolves to Turku's location within tolerance. Residual is NAME-CANONICALIZATION only — the resolver returns the alias name 'Åbo' instead of canonical 'Turku', so the component check ('Åbo' ≠ 'Turku') still holds it here. Distinct from the ranking bug #912 closed; belongs to the #897 exonym/name family.",
	},
	// #901 knife-edge sentinels (added 2026-07-03): the four SI short-village rows + the Učakar
	// digit-split form. The four-probe attribution proved these are knife-edge outputs of the
	// shipped encoder — ANY 2k init_from fine-tune of a surgery-lineage base tips them (zero-shard
	// control: 4/4 row-identity; embedding-freeze: still breaks). They are the v2.2.0 full
	// retrain's acceptance rows and the permanent early-warning sentinel for partial-update
	// damage. Coordinates = the OA SI gold for each address; Učakar expects the street WHOLE.
	{
		id: "si-sentinel-zabice",
		input: "Zabiče 8, 6250 Zabiče",
		source: "bug:#901",
		addressKind: "si_no_street_village",
		country: "SI",
		status: "pass",
		expectComponents: { locality: "Zabiče" },
		expectLat: 45.5150988,
		expectLon: 14.3438828,
		expectToleranceM: 25_000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 1/5: the v1.9.8 signature row. Resolved by the SHIPPED encoder; any encoder drift from partial fine-tunes breaks it first.",
	},
	{
		id: "si-sentinel-apace",
		input: "Apače 108, 2324 Apače",
		source: "bug:#901",
		addressKind: "si_no_street_village",
		country: "SI",
		status: "pass",
		expectComponents: { locality: "Apače" },
		expectLat: 46.3785077,
		expectLon: 15.8010729,
		expectToleranceM: 25_000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 2/5 (the '#723 would have relabeled this' row — house 108 must stay whole).",
	},
	{
		id: "si-sentinel-mlinse",
		input: "Mlinše 35C, 1411 Mlinše",
		source: "bug:#901",
		addressKind: "si_no_street_village",
		country: "SI",
		status: "pass",
		expectComponents: { locality: "Mlinše" },
		expectLat: 46.1467054,
		expectLon: 14.8834054,
		expectToleranceM: 25_000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 3/5: letter-suffixed house number (35C) on the no-street form.",
	},
	{
		id: "si-sentinel-zikarce",
		input: "Žikarce 22B, 2242 Žikarce",
		source: "bug:#901",
		addressKind: "si_no_street_village",
		country: "SI",
		status: "pass",
		expectComponents: { locality: "Žikarce" },
		expectLat: 46.5237521,
		expectLon: 15.7950198,
		expectToleranceM: 25_000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 4/5: leading Ž diacritic + letter-suffixed number.",
	},
	{
		id: "si-sentinel-ucakar",
		input: "Ulica bratov Učakar 54, 1000 Ljubljana",
		source: "bug:#901",
		addressKind: "si_street_full",
		country: "SI",
		status: "pass",
		expectComponents: { locality: "Ljubljana", house_number: "54" },
		expectLat: 46.0745,
		expectLon: 14.479,
		expectToleranceM: 25_000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 5/5 — PROMOTED 2026-07-24 (operator decision). The runner's promote-flag fired the moment the GauntletResult slice learned to carry house_number/street: the shipped pipeline DOES emit '54' whole, and the prior 'house_number null ≠ 54' failure was a harness artifact (the slice never carried the field), so this may have been passing invisibly for some time. Original framing: retrain acceptance row — the shipped pair yields NO house_number; probes split it mid-digit ('…Učakar 5' + '4'). Now gated so the digit-split can't silently return.",
	},
	// Venue-toponym traps (added 2026-07-10, contributed by a POSAIS attendee — real Paris venues whose
	// NAMES are toponyms pointing the wrong way). Live v5.9.0 behavior at intake: parís.méxico → Comer,
	// Georgia US (the Spanish verb matched a US town namesake); Bubble Tea → "Bubble Bubble", AU;
	// Shinjuku Pigalle → Tokyo. The class needs venue-kind detection + POI tier + the #1039 confidence
	// floor; coordinates = BAN rooftops of the actual venues (provenance: ban:fr release=2026-05-18).
	// Tolerance is metro-scale — the win condition is "lands in greater Paris or declines", not rooftop.
	{
		id: "venue-toponym-comer-paris-mexico",
		input: "COMER parís.méxico, 96 Rue d'Hauteville, 75010 Paris",
		source: "posais-attendee:2026-07-10",
		addressKind: "venue_toponym_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.87735,
		expectLon: 2.35157,
		expectToleranceM: 1500,
		addedAt: "2026-07-10",
		bugRef: "#1039",
		note: "Full form WITH address — the parser must route around the two-toponym Spanish-orthography venue name and use the address. Gates the venue-span/address-span separation on a carried address.",
	},
	{
		id: "venue-toponym-comer-bare",
		input: "COMER parís.méxico",
		source: "posais-attendee:2026-07-10",
		addressKind: "venue_toponym_trap",
		country: "FR",
		status: "improvement_target",
		expectLat: 48.87735,
		expectLon: 2.35157,
		expectToleranceM: 25_000,
		addedAt: "2026-07-10",
		bugRef: "#1039",
		note: "Bare venue name. Live at intake: Comer, Georgia US — a THIRD namesake (Spanish verb = US town). Needs POI tier or the #1039 confidence floor; a confident cross-continent pin is the failure being tracked.",
	},
	{
		id: "venue-toponym-shinjuku-pigalle",
		input: "Shinjuku Pigalle, Paris",
		source: "posais-attendee:2026-07-10",
		addressKind: "venue_toponym_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.88029,
		expectLon: 2.34309,
		expectToleranceM: 25_000,
		addedAt: "2026-07-10",
		bugRef: "#1039",
		note: "Venue at 52 Rue Condorcet 75009. Two toponyms in the name (Tokyo ward + Paris district); the bare form resolved to Shinjuku JP live at intake, but WITH the explicit ', Paris' the pipeline out-votes the venue span — promoted to pass at first run (2026-07-10), now pinned.",
	},
	{
		id: "venue-toponym-shinjuku-bare",
		input: "Shinjuku",
		source: "posais-attendee:2026-07-10",
		addressKind: "venue_toponym_trap",
		country: "JP",
		status: "pass",
		expectComponents: { locality: "Shinjuku" },
		expectLat: 35.701175,
		expectLon: 139.708848,
		expectToleranceM: 25_000,
		addedAt: "2026-07-10",
		bugRef: "#1039",
		note: "CONTROL: a bare lone toponym plausibly MEANS Tokyo; resolving it there is correct default behavior. This row pins that the venue-trap work must NOT overcorrect bare toponyms into no-results. (The Ivry-sur-Seine venue of the same name is only recoverable from conversational context no geocoder has.)",
	},

	// FR street-name homonyms (operator's Paris list, 2026-07-15). The street's NAME is a major
	// foreign city; the tolerance is what makes these mean something — Paris→Rome is ~1100 km, so a
	// 50 km band FAILS LOUD if the toponym ever out-competes the street reading. These PASS today;
	// they are here because two in-flight levers put them at risk: the #1103 morphology bias (a
	// re-probe is pre-registered now that the #727 span head landed) and any recalibration of the
	// gazetteer importance score (`impBias = importance * biasScale * maxBias`, neural/fst-prior.ts
	// — measured 2026-07-15: `rue` 0.149 / `boulevard` 0.167 / `place` 0.169 are themselves
	// gazetteer places, so raising importance would start biasing STREET-TYPE WORDS toward locality).
	// The 30 currently-FAILING bare-fragment forms deliberately do NOT live here — this file is the
	// executable bug log, not a wish list; they live in eval-harness/fixtures/paris-streets.jsonl.
	{
		id: "fr-rue-de-rome-homonym",
		input: "8 Rue de Rome, Paris",
		source: "operator:paris-list-2026-07-15",
		addressKind: "street_name_homonym",
		country: "FR",
		status: "pass",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8566,
		expectLon: 2.3428,
		expectToleranceM: 50_000,
		addedAt: "2026-07-15",
		note: "The street name IS a major city. Must land in PARIS, not Rome (~1100 km). Guards the house-number anchor that currently wins this: measured 2026-07-15, contextful/homonym is 6/6 while the BARE form 'Rue de Rome' emits nothing at all.",
	},
	{
		id: "fr-rue-de-constantinople-homonym",
		input: "7 Rue de Constantinople, Paris",
		source: "operator:paris-list-2026-07-15",
		addressKind: "street_name_homonym",
		country: "FR",
		status: "pass",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8566,
		expectLon: 2.3428,
		expectToleranceM: 50_000,
		addedAt: "2026-07-15",
		note: "Historical exonym for Istanbul — the toponym is not even a current place name, which is why it is a distinct trap from Rome/Londres.",
	},
	{
		id: "fr-rue-d-ulm-elision-homonym",
		input: "9 Rue d'Ulm, Paris",
		source: "operator:paris-list-2026-07-15",
		addressKind: "street_name_homonym",
		country: "FR",
		status: "pass",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8566,
		expectLon: 2.3428,
		expectToleranceM: 50_000,
		addedAt: "2026-07-15",
		note: "Two traps at once: an apostrophe elision (d') AND a German city (Ulm, ~600 km). Pins that the elision handling does not strand the name into a foreign-toponym reading.",
	},
	{
		id: "fr-chat-qui-peche-street-swallows-locality",
		input: "12 Rue du Chat-qui-Pêche, Paris",
		source: "operator:paris-list-2026-07-15",
		addressKind: "street_name_esoteric",
		country: "FR",
		status: "known_fail",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8531,
		expectLon: 2.3467,
		expectToleranceM: 50_000,
		addedAt: "2026-07-15",
		note: "Passes on the staged v3.11.x candidates (task-8 record) — flip to pass WHEN a lineage successor promotes; shipped v385 still fails (verified 2026-07-23). The street/locality boundary that swallowed 'Paris' on 2026-07-15 has since flipped in experimental lineages (#727 span-head). Was the only miss in the operator's 10-row tricky list (9/10 passed at the time); tracked as span-head's class. See final-review fix-wave report / #1189 adjudication for context.",
	},

	// Venue-name traps, carried-address form (operator's venue list, 2026-07-24). Sibling family of
	// the 2026-07-10 venue-toponym traps, but the venue NAMES here are mostly NOT foreign toponyms —
	// they're honorifics, digit-words, slashes, CJK script, and one Korean city. Seven of thirteen
	// resolve to the BAN rooftop TODAY (verified 2026-07-24, shipped model md5 700f3cf4, tier
	// address_point, uncertainty 1 m): the BAN tier keys on house_number+street+postcode, which all
	// parse cleanly, so the resolution is insensitive to the venue span. The six exceptions are gated
	// as improvement_target: venue-delta-restaurant-paris-6 (the venue's 'Paris 6' arrondissement
	// number
	// is grabbed as the house_number — rooftop still lands), venue-bangkok-factory-boulogne ('Bis'
	// glues into the street + the query falls to the admin tier), venue-nooyork-gravilliers-range
	// (the '46/48' slash-range parses whole but the BAN tier can't match the literal range form),
	// and venue-american-express-bercy (the brand demonym matched 'American', OHIO — a confident
	// cross-continent pin ignoring the explicit 75012 postcode; the #1039 failure mode),
	// and venue-bar-1802-pascal (the venue span consumed the address — '1802' as house_number, 'Bar'
	// as street, the real span destroyed), and venue-cathedrale-strasbourg (the venue name contains
	// the locality — 'Strasbourg' is consumed with it and the hierarchy collapses to country-only,
	// landing ~5.5 km from the cathedral).
	// The pinned residual across the whole batch is the LOCALITY SLOT: in every row the venue span
	// swallows `locality` ('Paris' is consumed — locality='MR', 'Le 9Neuf', 'SOKCHO 牛者', …), the
	// same venue-span/address-span separation defect the #1039 family tracks. These rows gate that
	// the carried address keeps out-voting the venue name — tolerance is metro-scale, the win
	// condition is 'lands the rooftop or declines'.
	{
		id: "venue-mr-mrs-crab-huchette",
		input: "MR & MRS CRAB, 20 Rue de la Huchette, 75005 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.853069,
		expectLon: 2.345524,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "English honorifics + ampersand ('MR & MRS') as the venue span — the parse strands locality='MR' (the span truncates at the &). Resolves to the 20 Rue de la Huchette BAN rooftop regardless; gates that honorific-shaped venue spans never out-vote the carried address.",
	},
	{
		id: "venue-le-9neuf-gaillon",
		input: "Le 9Neuf, 13 Rue Gaillon, 75002 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.868604,
		expectLon: 2.334157,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Digit-embedded venue name ('9Neuf') directly adjacent to the house number 13 — the digit must not fuse with or displace the real house number. Locality slot swallowed ('Le 9Neuf'); rooftop lands via the BAN tier.",
	},
	{
		id: "venue-sokcho-gyuja-antin",
		input: "SOKCHO 牛者, 6 Rue d'Antin, 75002 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.86816,
		expectLon: 2.332712,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "The one true toponym of the batch: Sokcho IS a South Korean city (Gangwon), plus CJK script (牛者) the tokenizer must not choke on. Cross-continent toponym + non-Latin script; the carried FR address wins via the BAN tier. Locality slot swallowed ('SOKCHO 牛者').",
	},
	{
		id: "venue-a-cafe-rivoli",
		input: "A/CAFÉ, 176 Rue de Rivoli, 75001 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.863034,
		expectLon: 2.334767,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Slash-punctuated name on a POI-category word ('CAFÉ') — the category word must not be read as a venue-kind hint that detaches the address. Locality slot swallowed ('A/CAFÉ'); rooftop lands via the BAN tier.",
	},
	{
		id: "venue-jjan-chatelet-pont-neuf",
		input: "JJAN! 짠 Châtelet, 14 Rue du Pont Neuf, 75001 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectLat: 48.860111,
		expectLon: 2.344315,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Triple trap: Hangul (짠), an exclamation mark, and an INTERNAL toponym — 'Châtelet' is a Paris hub name embedded in the venue span, on a street itself named after a bridge (Pont Neuf). The internal toponym happens to point at the right city, so a lucky hit would mask a miss elsewhere in Paris; the 1500 m band is the pin. Locality slot swallowed ('JJAN! 짠 Châtelet').",
	},
	{
		id: "venue-delta-restaurant-paris-6",
		input: "DELTA - Restaurant Paris 6, 8 Rue Princesse, 75006 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "8", street: "Rue Princesse" },
		expectLat: 48.852409,
		expectLon: 2.334436,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "The venue span carries an ARRONDISSEMENT NUMBER ('Paris 6') and the shipped parse grabs IT as the house_number ('6'), displacing the real '8'. Resolution still lands the correct #8 BAN rooftop today (verified byte-identical to the clean '8 Rue Princesse, 75006 Paris' probe) — the defect is parse-only, so the assertion is the components; coords+tier pin that the rooftop must not drift while the parse is fixed.",
	},
	{
		id: "venue-le-paris-paris-montfaucon",
		input: "Le Paris Paris, 8 Rue de Montfaucon, 75006 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectComponents: { house_number: "8", street: "Rue de Montfaucon" },
		expectLat: 48.852554,
		expectLon: 2.335793,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "The venue name IS the locality, doubled ('Le Paris Paris') — the strongest possible pull toward a locality-only reading. The parse keeps house_number/street clean (asserted) and the BAN rooftop lands; components asserted because a future model could start feeding the doubled 'Paris' into the address spans. Tracked residuals: locality slot swallowed ('Le Paris Paris') and a namesake contamination in the resolved hierarchy ('Le Touquet-Paris-Plage' appears as a locality node) — cosmetic today, neither moves the coordinate.",
	},
	{
		id: "venue-bangkok-factory-boulogne",
		input: "Bangkok Factory Boulogne, 33 Bis Rte de la Reine, 92100 Boulogne-Billancourt",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "33 Bis", street: "Route de la Reine" },
		expectLat: 48.838879,
		expectLon: 2.247654,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "First batch member OUTSIDE the 75 (92100, Hauts-de-Seine). Live: 'Bis' glues into the street ('Bis Rte de la Reine') and the query falls to the admin tier (Boulogne-Billancourt centroid ~700 m from the rooftop — inside the 1500 m band, so the TIER assertion is the gate, not the distance). The venue-free canonical '33 Bis Route de la Reine, 92100 Boulogne-Billancourt' DOES hit the BAN rooftop with house_number '33 Bis' whole (the asserted values are that observed canonical emission, not a guess); the venue prefix + 'Rte' abbreviation break what the bare form gets right. The Bangkok foreign-capital toponym correctly does NOT pull to TH (countryCode stays FR). Adjacent finding, not pinned here: the all-lowercase '33 bis rue de la Reine' bare form parses cleanly yet ALSO falls to admin — a case-sensitivity gap in the street-evidence/BAN match (#829 family).",
	},
	{
		id: "venue-american-bar-le-marais",
		input: "American Bar - Le Marais, 116 Rue du Temple, 75003 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "pass",
		expectComponents: { house_number: "116", street: "Rue du Temple" },
		expectLat: 48.862985,
		expectLon: 2.358059,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Two pulls at once: a country DEMONYM ('American' → US) and an internal Paris district toponym ('Le Marais') in the venue span, joined by a hyphen. Both stay inert — countryCode FR, the BAN rooftop lands, and house/street parse clean (asserted against a future model feeding either span into the address). Locality slot swallowed ('American Bar - Le Marais').",
	},
	{
		id: "venue-nooyork-gravilliers-range",
		input: "NooYork, 46/48 Rue des Gravilliers, 75003 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "46/48", street: "Rue des Gravilliers" },
		expectLat: 48.864135,
		expectLon: 2.355789,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Slash-RANGE house number ('46/48'). The parse is already correct (asserted: house_number '46/48' whole, street clean) — the defect is RESOLUTION-ONLY: the BAN tier can't match the literal '46/48' (BAN numbers the ends separately) and the query falls to the Paris admin centroid ~1.3 km away, INSIDE the 1500 m band, so the tier assertion is the gate. Both ends rooftop individually (46 → 48.86412,2.355843 / 48 → 48.86415,2.355734); expected = the midpoint, the fix is range-split → match either end or interpolate. The venue's misspelled-US-city toponym ('NooYork') stays FR. Locality slot swallowed ('NooYork').",
	},
	{
		id: "venue-american-express-bercy",
		input: "American Express Live Bar Live Bar, Espl. Johnny Hallyday, 75012 Paris",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectLat: 48.8386,
		expectLon: 2.3789,
		expectToleranceM: 25_000,
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "The worst live miss of the batch: resolves to American, OHIO (40.7691,-84.1732, countryCode US) — the brand's demonym matched a US locality literally named 'American', and the explicit 75012 postcode was ignored. A confident cross-continent pin, the exact #1039 failure mode. Contributing traps: brand-name venue, duplicated 'Live Bar Live Bar', a NUMBERLESS esplanade (no house number to anchor the BAN tier), the 'Espl.' abbreviation, and a person-name street. Even the venue-free 'Esplanade Johnny Hallyday, 75012 Paris' only reaches the Paris admin centroid (the numberless esplanade is no BAN street), so no address_point tier is asserted — expected coords are the real esplanade (Accor Arena, Bercy) at metro tolerance: the win condition is 'lands in greater Paris or declines', identical shape to venue-toponym-comer-bare. Needs the #1039 confidence floor + POI tier.",
	},
	{
		id: "venue-bar-1802-pascal",
		input: "Bar 1802, 22 Rue Pascal, 75005 Paris, France",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "22", street: "Rue Pascal" },
		expectLat: 48.837888,
		expectLon: 2.349263,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "The venue span CONSUMED the address: year-number '1802' grabbed as house_number, the kind word 'Bar' grabbed as the STREET, and the real '22 Rue Pascal' span vanished from the parse entirely (admin tier, Paris centroid ~2.2 km out — distance AND tier both gate). The venue-free '22 Rue Pascal, 75005 Paris' rooftops fine (the asserted values are that observed canonical emission). The trailing explicit ', France' at least holds countryCode FR. Second instance of the number-grab class (cf. venue-delta-restaurant-paris-6's 'Paris 6') but strictly worse — here the address span is destroyed, not just displaced.",
	},
	{
		id: "venue-cathedrale-strasbourg",
		input: "Cathédrale Notre-Dame-de-Strasbourg, Pl. de la Cathédrale, 67000 Strasbourg, France",
		source: "operator:venue-list-2026-07-24",
		addressKind: "venue_name_trap",
		country: "FR",
		status: "improvement_target",
		expectLat: 48.5819176,
		expectLon: 7.75025216,
		expectToleranceM: 1500,
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "First batch member beyond Île-de-France (67, Bas-Rhin) and the nastiest locality-swallow: the venue name CONTAINS the locality ('…Notre-Dame-de-Strasbourg'), the trailing 'Strasbourg' token is consumed with it, and the resolved hierarchy collapses to country-ONLY — the fallback lands at 48.5995,7.7847, ~5.5 km NE of the cathedral with no locality anchor at all. The venue-free canonical 'Place de la Cathédrale, 67000 Strasbourg' reaches the STREET tier (uncertainty 94 m) on the cathedral square; expected = that observed square centroid. Numberless 'Pl.' place → no BAN house-number anchor, so no tier is asserted (street is the achievable best today; a POI-tier fix may do better — the gauntlet ResolutionTier union gained 'street' for this family, it was a stale subset of geocode-core's).",
	},

	// Bare-form companion to the 2026-07-24 venue batch (same operator intake, but NO venue span):
	// the unspaced-bis resolution defect stands alone.
	{
		id: "fr-lyonnais-3bis-bare",
		input: "3bis Rue des Lyonnais, 75005 Paris, France",
		source: "operator:paris-list-2026-07-24",
		addressKind: "fr_street_bis",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "3bis", street: "Rue des Lyonnais" },
		expectLat: 48.837955,
		expectLon: 2.347238,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		bugRef: "#1039",
		note: "Unspaced '3bis' on a real bis address. The parse is already correct ('3bis' whole, street clean — asserted so it stays whole) — the defect is RESOLUTION-ONLY: admin tier, Paris centroid ~2.2 km out. The street IS BAN-resolvable ('3'/'5 Rue des Lyonnais' both rooftop at uncertainty 1 m) and the matcher CAN handle bis ('33 Bis Route de la Reine' rooftops, cf. venue-bangkok-factory-boulogne) — so either BAN lacks the 3bis record for this street and the ladder must relax to the base number, or the suffix match is street-specific. Expected coords = the observed #3 BAN rooftop (bis shares the plot); the spaced form '3 Bis' fails identically (verified same probe).",
	},

	// Comma-dependence pair (operator probe, 2026-07-24) — same street, same number, the ONLY
	// difference is the comma-borne admin context. The bare form parses perfectly then DECLINES
	// (null coords); the comma form rooftops at 1 m. Google Maps resolves the bare form to the
	// Paris address; we emit nothing. The 2026-07-15 homonym note already observed the class
	// ('the BARE form Rue de Rome emits nothing at all') — this pair pins it end-to-end on a
	// street whose comma form is proven resolvable. The third row repeats the bare form WITH an
	// explicit FR country prior: it STILL declines (verified 2026-07-24 — neither defaultCountry=FR
	// nor a Paris proximity-bias point rescues it), proving the missing street-search-without-admin
	// path can't be worked around by scoping; that row is the fix's natural acceptance row.
	{
		id: "fr-lyonnais-3-bare-country-bias",
		input: "3 Rue des Lyonnais",
		source: "operator:comma-probe-2026-07-24",
		addressKind: "fr_street_no_context",
		country: "FR",
		status: "improvement_target",
		defaultCountry: "FR",
		expectComponents: { house_number: "3", street: "Rue des Lyonnais" },
		expectLat: 48.837955,
		expectLon: 2.347238,
		expectToleranceM: 1500,
		addedAt: "2026-07-24",
		note: "The bare form WITH an explicit FR resolver prior (defaultCountry='FR'). Still declines today — the resolver never reaches street search even with the country pinned, so the comma-dependence fix must wire the country prior INTO street search, not just admin resolution. Same expected rooftop as the comma control; no tier asserted. When street-search-without-admin lands, this FR-scoped variant should be the FIRST of the bare pair to pass — the runner's promote-flag watches for it.",
	},
	{
		id: "fr-lyonnais-3-bare-no-context",
		input: "3 Rue des Lyonnais",
		source: "operator:comma-probe-2026-07-24",
		addressKind: "fr_street_no_context",
		country: "FR",
		status: "improvement_target",
		expectComponents: { house_number: "3", street: "Rue des Lyonnais" },
		expectLat: 48.837955,
		expectLon: 2.347238,
		expectToleranceM: 1500,
		addedAt: "2026-07-24",
		note: "The bare form: house_number+street with ZERO admin context. Parse is perfect (asserted) but resolution declines outright (null lat/lon, empty hierarchy — the 'admin' tier label with no place). The fix is street-search-without-admin: the street exists in exactly one gazetteer location, so a street+number-only query should reach it the way Google Maps does. No tier asserted — address_point is achievable (the comma form proves the BAN record exists) but a street-tier landing is also a win; the gate is 'resolves at all, at the right place'. Rue des Lyonnais is short (~100 m), so 1500 m is generous but still loud against the null decline.",
	},
	{
		id: "fr-lyonnais-3-comma-control",
		input: "3 Rue des Lyonnais, 75005 Paris",
		source: "operator:comma-probe-2026-07-24",
		addressKind: "fr_street_postcode",
		country: "FR",
		status: "pass",
		expectComponents: { house_number: "3", street: "Rue des Lyonnais", locality: "Paris" },
		expectLat: 48.837955,
		expectLon: 2.347238,
		expectToleranceM: 1500,
		expectTier: "address_point",
		addedAt: "2026-07-24",
		note: "CONTROL: the identical street+number WITH comma-borne postcode+locality rooftops at uncertainty 1 m. Byte-stability guard — the comma-dependence fix (making the bare form resolve) must not disturb the working comma path. Also the anchor proving the expected coords of the bare sibling are a real BAN rooftop, not a wish.",
	},
]
