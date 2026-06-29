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
		// Entry #1 — the bare French street the model fragmented + the OSM rooftop tier. Was admin 3.19km.
		id: "fr-bare-chevaleret",
		input: "181 Rue du Chevaleret, Paris",
		source: "bug:#828",
		addressKind: "fr_street_bare",
		country: "FR",
		status: "pass",
		expectLat: 48.8335023,
		expectLon: 2.3686051,
		expectToleranceM: 80,
		expectTier: "address_point",
		addedAt: "2026-06-29",
		bugRef: "#251 / #828",
		note: "Bare FR street, NO postcode. v1.9.4 parse fix (postcode-anchoring) + OSM FR rooftop tier. Pre-fix: street fragmented to 'Rue du', resolved to the arrondissement centroid (3.19km).",
	},
	{
		// A US landmark anchor — guards the US admin/street path doesn't drift while we touch intl.
		id: "us-dc-pennsylvania",
		input: "1600 Pennsylvania Ave NW, Washington DC",
		source: "golden",
		addressKind: "us_landmark",
		country: "US",
		status: "pass",
		expectComponents: { country: "US", region: "DC", locality: "Washington" },
		expectLat: 38.8977,
		expectLon: -77.0365,
		expectToleranceM: 1500,
		addedAt: "2026-06-29",
		note: "Well-known US address; anchors that the US path stays put across intl changes.",
	},
	{
		// The 'Ave recovered as a French locality' span-rescore bug (66ff2e68). Assertion: resolves in NY/US, NOT France.
		id: "us-5th-ave-ny-rescore",
		input: "350 5th Ave, New York, NY",
		source: "bug:span-rescore",
		addressKind: "us_street_ambiguous",
		country: "US",
		status: "pass",
		expectComponents: { country: "US", region: "NY", locality: "New York" },
		expectLat: 40.74858,
		expectLon: -73.98526,
		expectToleranceM: 20000,
		addedAt: "2026-06-29",
		bugRef: "span-rescore confidentRanges (street affix)",
		note: "Pre-fix the span-rescore recovered 'Ave' as a same-named French locality (48.57,0.28). Must resolve in NY, not France.",
	},
]
