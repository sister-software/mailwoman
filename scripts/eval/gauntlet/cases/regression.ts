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
	expectPlaceId?: string
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
		// The BARE no-postcode form mis-parses ('Chevaleret' → locality) → admin. Tracked, non-gated; the
		// metamorphic carries the surface-perturbation evidence. Promote to status=pass when #831 is fixed.
		id: "fr-chevaleret-bare",
		input: "181 Rue du Chevaleret, Paris",
		source: "bug:#831",
		addressKind: "fr_street_bare",
		country: "FR",
		status: "known_fail",
		expectLat: 48.8335023,
		expectLon: 2.3686051,
		expectToleranceM: 80,
		expectTier: "address_point",
		addedAt: "2026-06-29",
		bugRef: "#831",
		note: "Bare no-postcode FR street. Canonical mixed-case mis-parses 'Chevaleret' as the locality → arrondissement centroid (3.19km). Surface perturbations DO hit rooftop (the #831 boundary).",
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
		note: "Was Augusta, Sicily — the two-consistent-pairs case (Augusta under both Maine and Messina). Fixed by the abbrev-only country_hint forward linkage (recognizeUsRegions → resolver country=US), not the descendant-consistency pass.",
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
]
