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

import type { AddressKind, CaseStatus, ResolutionTier } from "../schema.ts"

export interface SeedCase {
	id: string
	input: string
	source: string
	addressKind: AddressKind
	country: string
	status: CaseStatus
	/** Asserted admin/parse fields, when relevant — `{ country?, region?, locality? }` (matched case-insensitively). */
	expectComponents?: Record<string, string>
	expectPlaceID?: string
	expectPlaceName?: string
	expectLat?: number
	expectLon?: number
	/** Great-circle tolerance (m). Defaults at runtime when absent. */
	expectToleranceM?: number
	expectTier?: ResolutionTier
	addedAt: string
	bugRef?: string
	note?: string
}

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
		expectToleranceM: 500000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		status: "improvement_target",
		expectComponents: { locality: "Ljubljana", house_number: "54" },
		expectLat: 46.0745,
		expectLon: 14.479,
		expectToleranceM: 25000,
		addedAt: "2026-07-03",
		bugRef: "#901",
		note: "Knife-edge sentinel 5/5 + retrain acceptance row: the SHIPPED pair yields NO house_number here; probes split it mid-digit ('…Učakar 5' + '4'). The v2.2.0 retrain must produce house_number '54' whole.",
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
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
		expectToleranceM: 25000,
		addedAt: "2026-07-10",
		bugRef: "#1039",
		note: "CONTROL: a bare lone toponym plausibly MEANS Tokyo; resolving it there is correct default behavior. This row pins that the venue-trap work must NOT overcorrect bare toponyms into no-results. (The Ivry-sur-Seine venue of the same name is only recoverable from conversational context no geocoder has.)",
	},

	// ---------------------------------------------------------------------------------------------
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
	// ---------------------------------------------------------------------------------------------
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
		status: "pass",
		expectComponents: { locality: "Paris" },
		expectLat: 48.8531,
		expectLon: 2.3467,
		expectToleranceM: 50_000,
		addedAt: "2026-07-15",
		note: "Promoted to status=pass (2026-07-23, Task 8 ship-prep battery + final-review fix wave): the street/locality boundary that swallowed 'Paris' on 2026-07-15 has since flipped — the case now resolves correctly. Was the only miss in the operator's 10-row tricky list (9/10 passed at the time); tracked as the #727 span-head's class, and it flipped as expected once that machinery landed. Verified in the regression layer's 33/33 gated-case PASS (feed-8k battery, `.superpowers/sdd/task-8-prep-report.md`, `docs/articles/evals/2026-07-23-placetype-pair-scorecard.md`'s Gauntlet section).",
	},
]
