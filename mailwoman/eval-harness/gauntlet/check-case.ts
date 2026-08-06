/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Gauntlet's per-case grader: one stored case + one assembled result → the list of mismatches.
 *
 *   PURE, and its own module for exactly that reason. It lived inside `runRegressionLayer`'s closure until
 *   2026-08-06, where the only way to exercise it was to build the ~9 GB shard set and run 306 addresses
 *   end-to-end — so the assertions this file makes had never been unit-tested, and #1507's finding (two stored
 *   expectation columns that no branch here ever read) survived every review of the layer that calls it.
 */

import { tryParsingJSON } from "@mailwoman/core/objects"
import { haversineKm } from "@mailwoman/spatial"

import type { GauntletResult } from "./harness.ts"
import type { GauntletCaseTable } from "./schema.ts"

/**
 * Great-circle tolerance applied when a case pins a coordinate but no `expect_tolerance_m`.
 */
export const DEFAULT_TOL_M = 5000

/**
 * Map an expect_components key to the assembled-result field it asserts.
 *
 * Exported for the ablation layer, which scores a DELETION against the same slot this gate grades — a second copy of
 * the mapping would let the two disagree about which field `venue` lives in, and the ablation runner would then report
 * "the slot stayed empty" for a slot it was reading off the wrong field.
 */
export function componentOf(r: GauntletResult, key: string): string | null {
	switch (key) {
		case "country":
			return r.country
		case "region":
			return r.region
		case "locality":
			return r.locality
		case "house_number":
			return r.house_number
		case "street":
			return r.street
		case "postcode":
			return r.postcode
		case "venue":
			return r.venue
		case "dependent_locality":
			return r.dependent_locality
		case "unit":
			return r.unit
		default:
			// LOUD: a silent null here made venue/dependent_locality expectations grade against
			// nothing for their whole life (caught 2026-08-01). An unknown key is an authoring bug.
			throw new Error(`expect_components key "${key}" has no GauntletResult mapping — extend componentOf`)
	}
}

/**
 * The resolved place a `expect_place_id` / `expect_place_name` row grades against: the most specific admin node the
 * RESOLVER decorated (`hierarchy` is sorted locality → dependent_locality → subregion → region → country).
 *
 * READ THIS BEFORE CHANGING IT. The obvious-looking target, {@linkcode GauntletResult.locality}, is the wrong one: it
 * echoes the parsed QUERY SPAN (`geocode-core.ts`'s `allNodes.find(...).value`), so `Gaborone` in yields `Gaborone` out
 * no matter which place the resolver actually returned. `hierarchy[].name` is the gazetteer's canonical
 * `resolver_name`, which is the only field in the result that can disagree with the input — and disagreeing with the
 * input is the entire point of this assertion.
 */
function resolvedPlace(r: GauntletResult): GauntletResult["hierarchy"][number] | undefined {
	return r.hierarchy[0]
}

/**
 * Assert one assembled result against its stored case; returns the mismatches (empty = the case passes).
 *
 * Four independent gates, all opt-in per row — a null column asserts nothing:
 *
 * 1. COORDINATE, great-circle against `expect_tolerance_m` (default {@linkcode DEFAULT_TOL_M}).
 * 2. TIER, strict — an `address_point` that drifts to `admin` is a regression even inside tolerance.
 * 3. PLACE IDENTITY (#1507, wired 2026-08-06) — `expect_place_name` / `expect_place_id` against the resolved
 *    {@linkcode resolvedPlace}. This is the one the other three cannot express: the country sweep's family-A rows
 *    (Gaborone → the Austrian hamlet `Aichegg`, Kinshasa → `Alionys II`, Djibouti → `Ober-Himmeri`) came back with the
 *    RIGHT parsed locality and only a coordinate 8,045 km away to say so, and a row whose expected place sits inside a
 *    25 km bar of its impostor would have had nothing at all. The corpus stored both columns from the first migration
 *    and no branch read them, so "wrong place, plausible coordinate" was unassertable for the corpus's whole life.
 * 4. COMPONENTS, case-insensitive per key, against the parsed/assembled spans. Last because a corrupt `expect_components`
 *    JSON short-circuits the rest of ITS gate, and the place gate must still have run.
 */
export function checkCase(c: GauntletCaseTable, r: GauntletResult): string[] {
	const issues: string[] = []

	if (c.expect_lat != null && c.expect_lon != null) {
		const tolKm = (c.expect_tolerance_m ?? DEFAULT_TOL_M) / 1000
		const km = r.lat != null && r.lon != null ? haversineKm(r.lat, r.lon, c.expect_lat, c.expect_lon) : Infinity

		if (km > tolKm) {
			issues.push(
				`coord ${km === Infinity ? "unresolved" : `${km.toFixed(2)}km off`} (tol ${c.expect_tolerance_m ?? DEFAULT_TOL_M}m)`
			)
		}
	}

	if (c.expect_tier != null && r.tier !== c.expect_tier) {
		issues.push(`tier ${r.tier} ≠ ${c.expect_tier}`)
	}

	if (c.expect_place_id != null || c.expect_place_name != null) {
		const place = resolvedPlace(r)

		if (!place) {
			issues.push(
				`place unresolved (hierarchy empty) ≠ ${c.expect_place_name ? `"${c.expect_place_name}"` : c.expect_place_id}`
			)
		} else {
			// Case-insensitive, matching the component gate: the corpus is authored from an oracle's rendering, and
			// casing is the gazetteer's business (`resolver_name` is proper-cased canonical, #1014).
			if (c.expect_place_name != null && place.name.toLowerCase() !== c.expect_place_name.toLowerCase()) {
				issues.push(`place name "${place.name}" ≠ "${c.expect_place_name}"`)
			}

			// EXACT, unlike the name: a place id is an opaque key (`wof:1108826319`), not prose.
			if (c.expect_place_id != null && place.placeID !== c.expect_place_id) {
				issues.push(`place id "${place.placeID ?? null}" ≠ "${c.expect_place_id}"`)
			}
		}
	}

	if (c.expect_components != null) {
		// From our own builder's JSON.stringify, so malformed = a corrupt DB row — surface it as a
		// case issue (loud, per-case) rather than letting a raw SyntaxError kill the whole gate.
		const exp = tryParsingJSON<Record<string, string>>(c.expect_components)

		if (!exp) {
			issues.push(`expect_components is not valid JSON (corrupt regression.db row?)`)

			return issues
		}

		for (const [k, v] of Object.entries(exp)) {
			const got = componentOf(r, k)

			if ((got ?? "").toLowerCase() !== v.toLowerCase()) {
				issues.push(`${k} "${got}" ≠ "${v}"`)
			}
		}
	}

	return issues
}
