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
		// #832 — "New York" (NYC) is dropped from the FTS over-fetch window (alt-name-diluted bm25), so the
		// tiny "New York Mills" (pop 3,190) outranks NYC (pop 8.8M). Tracked target until the exact-match floor lands.
		id: "us-new-york-nyc",
		input: "New York, NY",
		source: "bug:#832",
		addressKind: "us_city_state",
		country: "US",
		status: "improvement_target",
		expectComponents: { region: "NY", locality: "New York" },
		expectLat: 40.6945,
		expectLon: -73.9304,
		expectToleranceM: 25000,
		addedAt: "2026-06-29",
		bugRef: "#832",
		note: "Bare 'New York, NY' resolves to New York Mills (upstate, 43.10) instead of NYC. The placer is correct (US 0.92); this is the FTS ranking.",
	},
	{
		// #833 — the placer mis-predicts Portland/ME → GB (Portland Dorset + 'ME' Medway), and the soft prior
		// can't stop the IT 'ME'=Messina province match. Tracked until the placer + #194 hard-filter land.
		id: "us-portland-me",
		input: "Portland, ME",
		source: "bug:#833",
		addressKind: "us_city_state",
		country: "US",
		status: "improvement_target",
		expectComponents: { region: "ME", locality: "Portland" },
		expectLat: 43.647,
		expectLon: -70.168,
		expectToleranceM: 25000,
		addedAt: "2026-06-29",
		bugRef: "#833",
		note: "Bare 'Portland, ME' resolves to Messina, Italy. The placer predicts GB 0.79 for it; works with the full state name ('Portland, Maine').",
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
]
