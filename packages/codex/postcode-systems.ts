/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The inverse of the per-slice postcode patterns: given a postcode string, which address SYSTEMS
 *   could it belong to? Each codex slice owns its own postcode shape (`us` accepts
 *   `\d{5}(-\d{4})?`, `ca` accepts `A1A 1A1`, `jp` accepts `NNN-NNNN`, …); this is the single place
 *   that asks all of them at once and collects the matches.
 *
 *   It is the shared source of truth for "which systems can this shape be" — consumed by the postcode
 *   anchor (to narrow which systems' street vocabularies it checks) and, in time, by the runtime
 *   pipeline's locale gate (so its format→locale scoring derives from the same patterns rather than
 *   a second, divergent copy). The point is to unify the DATA, not to couple the modules: callers
 *   depend on this pure function, never on each other.
 *
 *   Note this is a SHAPE test, not a gazetteer-membership test. A bare `68161` matches the US,
 *   German, AND French 5-digit shapes, so it returns `["us", "de", "fr"]` — the shape alone cannot
 *   split the numeric-postcode systems. The anchor uses real gazetteer membership for the finer
 *   call; this function answers the coarser, model-free "which systems is this shape even eligible
 *   for".
 */

import { normalizeAuPostcode } from "#au/index"
import { normalizeCaPostalCode } from "#ca/index"
import { normalizePLZ } from "#de/index"
import { normalizeCodePostal } from "#fr/index"
import { normalizeUkPostcode } from "#gb/index"
import { normalizeJpPostalCode } from "#jp/index"
import { normalizeNZPostcode } from "#nz/index"
import { isZipCode } from "#us/index"

/**
 * A codex address-system code — the subpath under `@mailwoman/codex/<system>`.
 */
export type SystemCode = "us" | "de" | "fr" | "ca" | "gb" | "jp" | "au" | "nz"

/**
 * Per-system membership test: each entry returns true when the string is accepted by that system's own postcode shape
 * (after that system's normalization — so `D-68161` reaches `de`, `1012 LM` reaches nothing here since NL has no slice
 * yet, etc.). Ordered for a stable, alphabetical-ish result.
 */
const SYSTEM_ACCEPTS: ReadonlyArray<readonly [SystemCode, (s: string) => boolean]> = [
	["us", (s) => isZipCode(s)],
	["de", (s) => normalizePLZ(s) !== null],
	["fr", (s) => normalizeCodePostal(s) !== null],
	["ca", (s) => normalizeCaPostalCode(s) !== null],
	["gb", (s) => normalizeUkPostcode(s) !== null],
	["jp", (s) => normalizeJpPostalCode(s) !== null],
	["au", (s) => normalizeAuPostcode(s) !== null],
	["nz", (s) => normalizeNZPostcode(s) !== null],
]

/**
 * Every address system whose own postcode shape accepts `postcode`. Empty when no system recognizes the shape (e.g. a
 * bare `27`, or a 7-digit run). O(number of systems) — a handful of cheap regex tests, run only on the few
 * postcode-shaped spans an address contains.
 */
export function candidateSystemsForPostcode(postcode: string): SystemCode[] {
	if (typeof postcode !== "string" || !postcode.length) return []
	const out: SystemCode[] = []

	for (const [system, accepts] of SYSTEM_ACCEPTS) {
		if (accepts(postcode)) {
			out.push(system)
		}
	}

	return out
}

/**
 * Postcode shapes whose code is UNIT-GRADE — a delivery-walk or street-block unit, categorically tighter than any
 * locality centroid, so an EXACT hit on one may lead the admin ladder instead of following the locality-first epoch
 * convention.
 *
 * The convention exists because most postal systems are AREA-class: an FR 5-digit zone is coarser than the commune it
 * contains, so promoting it would trade a good answer for a worse one. Two systems are the other way round, and
 * membership here is earned by MEASUREMENT of the code's granularity, never by "the code has letters in it":
 *
 * - **NL PC6** (`1012 LG`) — ~8 addresses per code; the CBS polygon centroid (#977, the original carve-out).
 * - **GB unit** (`N7 0BT`) — ~15 addresses per code, 1,751,733 shipped from OS Code-Point Open. Measured 2026-08-10
 *   against the panel-v2 GB rooftop truth: unit centroid within 1 km on 15/15 rows, median 38 m, max 100 m, while the
 *   locality centroid the ladder returned instead was 5.1–14.6 km out.
 * - **CA URBAN LDU** (`M1J 1A8`) — 843,739 six-character codes. Measured on 879 graded rows of the CA OSM-rooftop panel,
 *   through the production candidate backend, ladder arm against ladder arm:
 *
 *   | 732 URBAN rows | p50 | p75 | p90 | ≤1 km | | -------------- | ---: | ---: | ---: | ---: | | locality-first | 2.51
 *   km | 5.42 km | 9.53 km | 26.4% | | postcode-first | **78 m** | **162 m** | **373 m** | **94.7%** |
 *
 *   Closer on 90.4% of them. That is GB's tier on a sample fifty times larger than GB's.
 *
 * **CA RURAL is excluded, and the code says which.** Canada Post puts a `0` in the SECOND position of a rural forward
 * sortation area, so `T0H 1M0` is rural and `M1J 1A8` is not — no lookup required. A rural LDU serves a delivery route
 * rather than a block face, and it measures like one. On the same panel, the 114 rural rows:
 *
 * | 114 RURAL rows | p50       | p75         | p90         | ≤1 km     |
 * | -------------- | --------: | ----------: | ----------: | --------: |
 * | locality-first | **929 m** | **2.02 km** | **5.73 km** | **53.5%** |
 * | postcode-first | 2.08 km   | 4.79 km     | 8.11 km     | 25.4%     |
 *
 * Postcode-first is closer on only 26.3% of them, so the pattern below admits `[1-9]` in that position and nothing
 * else. `509 Main Street South-West Falher AB T0H 1M0` is the worked case: 0.29 km from the locality centroid and 43.18
 * km from its own postal code.
 *
 * The pooled CA number hides that entirely — 0.10 km p50 across both populations reads as a uniform win and is not one.
 * A tier claim that averages two granularities is the thing this table exists to prevent.
 *
 * Lives in codex (per-address-system postal reference) so the Node result assembly (`mailwoman/geocode-core`) and the
 * demo's pin ranking consume ONE tier definition — the 2026-08-11 staged-repoint e2e measured the two disagreeing.
 */
export const UNIT_GRADE_POSTCODE: ReadonlyArray<RegExp> = [
	// NL PC6 — `1012 LG` / `1012LG`.
	/^\d{4}\s?[A-Z]{2}$/i,
	// GB unit — outward (1-2 letters + digit + optional alnum) + inward `\d[A-Z]{2}`, the same shape
	// `@mailwoman/codex/gb`'s UK_POSTCODE_PATTERN anchors, restated here so this module stays
	// dependency-free within the package (the slices import THIS, never the reverse).
	/^[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}$/i,
	// CA urban LDU — `M1J 1A8`. The `[1-9]` in the second position is the whole tier claim: a `0` there marks a RURAL
	// forward sortation area, which measures 2.08 km p50 against the locality's 929 m and does not belong here.
	/^[A-Z][1-9][A-Z]\s?\d[A-Z]\d$/i,
]

/**
 * Strip everything but letters and digits, upper-cased — the comparison surface for "did the resolver hit the FULL code
 * or a coarser stem?". `N7 0BT` and `N70BT` are the same code; `N7` is not.
 */
const alnum = (s: string): string => s.replaceAll(/[^\p{L}\p{N}]/gu, "").toUpperCase()

/**
 * True when a resolved postcode is an EXACT hit on a unit-grade code — the #977 three-way guard, shared by the Node
 * ladder and the demo pin ranking:
 *
 * 1. The PARSED span is a full unit shape ({@link UNIT_GRADE_POSTCODE}), not a stem the user typed;
 * 2. The node resolved (a coordinate is present — checked by the caller); and
 * 3. The resolver's own hit is the FULL code, not a coarsened prefix (a 4-digit NL stem or a GB outward district is
 *    AREA-class, and promoting it is the exact trade the epoch convention forbids).
 */
export function isUnitGradePostcodeHit(parsed: string, resolverName: string | undefined): boolean {
	const value = parsed.trim()

	if (!value || !UNIT_GRADE_POSTCODE.some((re) => re.test(value))) return false

	return alnum(resolverName ?? "") === alnum(value)
}

/**
 * Address systems whose AREA-grade postal code is still FINER than the locality containing it — the third granularity
 * tier, between {@link UNIT_GRADE_POSTCODE} and the locality-first default.
 *
 * Whether a postal zone is coarser than its locality is a fact about a country's ADMINISTRATIVE geography, not about
 * its postal system, and code length does not predict it: FR and DE are both 5-digit and land on opposite sides. France
 * has ~35,000 communes and one code postal often spans several, so the commune is finer. A German Gemeinde can be
 * enormous — Berlin is one WOF locality — so the PLZ is finer by a wide margin.
 *
 * Membership is earned by a full-panel measurement, the same bar {@link UNIT_GRADE_POSTCODE} sets for CA. Coordinate
 * p50 on the OpenAddresses panels, locality-first (the default) against the postcode point:
 *
 * | country | rows  | locality-first | postcode point | verdict                                                            |
 * | ------- | ----: | -------------: | -------------: | ------------------------------------------------------------------ |
 * | **DE**  | 2,997 | 5.84 km        | **1.24 km**    | postcode, on EVERY percentile incl. p99 (21.50 → 10.57)            |
 * | FR      | 3,000 | **0.97 km**    | 2.64 km        | locality, closer on 77.5% of rows                                  |
 * | IT      | 2,833 | **1.34 km**    | 3.05 km        | locality, closer on 66.4%                                          |
 * | ES      | 2,929 | **0.68 km**    | 0.97 km        | locality, but near a coin flip — 46.1% of rows prefer the postcode |
 * | US      | 577   | **2.28 km**    | 4.15 km        | locality (see below)                                               |
 *
 * **The US row is measured on the population production actually sends to the ladder.** Its rooftop cascade is US-only
 * by construction (`selectAddressPointsDB` composes `address-points-us-<slug>.db`), and it serves 94.2% of US queries,
 * so only 577 of 10,000 panel rows reach an admin decision at all. Those are the rows no rooftop or interpolation shard
 * could place, which skews rural — exactly where a locality centroid sits close and a ZIP zone is wide. Measured over
 * all 10,000 rows instead, the US looks like a postcode-first country (2.41 km vs 3.63); that is a selection effect,
 * and it is why this table reports 577 rows for the US and full panels for the others, which have no such cascade.
 */
export const AREA_POSTCODE_FINER_THAN_LOCALITY: ReadonlySet<string> = new Set(["DE"])

/**
 * True when this country's area-grade postal code outranks its locality. Absent or unknown country → false, so the
 * locality-first convention is what an unscoped query gets.
 */
export function areaPostcodeLeadsLocality(country: string | undefined): boolean {
	return country !== undefined && AREA_POSTCODE_FINER_THAN_LOCALITY.has(country.trim().toUpperCase())
}
