/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode-prefix prior (#31, Mechanism 3) — the partial-code prior for postcodes the full-code
 *   gazetteer does not carry. #1480's abstention is the defect: a BT unit with no permissive source
 *   behind it (the NI half of Code-Point Open) misses the gazetteer, and the tree contributes
 *   NOTHING for it — no country scope, no district, no coordinate. This module derives the code's
 *   PREFIX and probes the PFX1 index (`postcode-prefix-<cc>.bin`), so the resolve "abstains on the
 *   UNIT and still contributes its DISTRICT": the node resolves from the prefix's centroid and/or
 *   ancestry, whichever the artifact carries.
 *
 *   The index is a structural type (`PostcodePrefixIndexLike`, declared in `core/resolver/types.ts`),
 *   injected by the pipeline and never imported from `@mailwoman/neural` — B3-5: the probe touches
 *   zero model inputs. The loader lives in `@mailwoman/neural/postcode-prefix-index.ts` (PFX1 format:
 *   magic, header, dictionary, quantized i16 coordinates, `radiusP95Km`, ancestry); the resolver
 *   side only defines the derivation law and the probe.
 *
 *   ## The derivation law (per artifact country)
 *
 *   - **GB** — the OUTWARD code: the compact (whitespace-stripped) form minus its trailing 3 unit
 *     characters ("SW1A 2AA" → "SW1A", "BT9 5GS" → "BT9"). Never a greedy regex — the unit is
 *     exactly 3 chars in the compact form, and `outwardOf` in `mailwoman/gazetteer-pipeline/
 *     postcode-prefix.ts` is the build-side twin of this law.
 *   - **US** — the 3-digit section ("94043" → "940"). M-3 measured 3 digits as the first length
 *     where the ZIP prefix stops being free (145 km p95 median); a 5-digit artifact would be the
 *     full code the gazetteer already carries. No US artifact ships yet (B3-4 needs a ZCTA
 *     acquisition) — the branch exists so the law is tested before the data.
 *   - **Anything else** — abstain (null).
 *
 *   ## The probe's country restriction
 *
 *   The index is country-specific EVIDENCE: it is only probed when its `country` matches the
 *   query's country scope (or the scope is absent). A GB index must not speak under a US scope —
 *   the pipeline passes the locale's index, and the walk's country filter is the caller's declared
 *   universe.
 *
 *   ## Metadata contract (what the node carries afterward)
 *
 *   - `postcode_prefix` — the prefix string that resolved it.
 *   - `postcode_prefix_ancestors` — the ancestry the prefix asserts (coarsest-first; GB outward
 *     nodes carry country → constituent-country → district).
 *   - `postcode_prefix_radius_p95_km` — the artifact's measured p95 radius, when the node carries a
 *     coordinate (M-3's receipt: a 1-digit US band and a GB outward code differ by 200×; never read
 *     a coordinate without its radius).
 *   - `coordinate_source: "postcode_prefix"` — ONLY when the node actually carries a coordinate.
 *     The ancestry-only tier (NI's 80 BT districts) stays coordinate-free — the meaning-of-zero
 *     rule, and the half that decides B3-3: inventing a BT centroid would reproduce the `BT3 9QQ` →
 *     Sheffield defect #1480 just fixed.
 *
 *   **D-rule: opt-in behind `ResolveOpts.postcodePrefixPrior`, default-OFF** (the PCN1 posture:
 *   data + loader + offline probe, no decode wiring; the header ships without `delta` until a
 *   calibration measures one). Bars: B3-2 (≥60% of held-out units within 10 km, zero worse than the
 *   abstention arm), B3-3 (NI ≥95% country scope GB + NIR ancestry + correct district named, 0%
 *   coordinate), B3-5 (structural — no model inputs touched).
 */

import type { PostcodePrefixIndexLike, PostcodePrefixNode, ResolvedPlace } from "@mailwoman/core/resolver"

/**
 * A resolved place that may carry NO coordinate. `ResolvedPlace` requires `lat`/`lon` (every gazetteer row has a value,
 * even the 0,0 unlocated sentinel), and the prefix prior's ancestry-only tier must express absence as `undefined`
 * instead — B3-3: inventing a centroid would reproduce the `BT3 9QQ` → Sheffield defect #1480. `decorateNode` copies
 * `lat`/`lon` onto the node verbatim, so an undefined coordinate stays absent on the node — the meaning-of-zero rule.
 * Widened ONLY at this boundary: gazetteer places (always coordinate-bearing) remain plain `ResolvedPlace`.
 */
export type CoordinateOptionalPlace = Omit<ResolvedPlace, "lat" | "lon"> & { lat?: number; lon?: number }

/**
 * The MINIMUM compact code length for a GB outward derivation — a shorter code has no 3-character unit to strip ("B3"
 * is a GB area, not a unit-bearing code).
 */
const MIN_GB_OUTWARD_CODE_LENGTH = 5

/**
 * The MINIMUM code length for a US section derivation.
 */
const MIN_US_SECTION_CODE_LENGTH = 3

/**
 * Derive the prefix the index is keyed by, per the artifact's own country law. Returns null (abstain) for a country
 * with no derivation law, or a code too short to carry a prefix.
 */
export function derivePostcodePrefix(code: string, country?: string): string | null {
	if (!code || !country) return null

	const compact = code.replaceAll(/\s+/g, "")

	switch (country.toUpperCase()) {
		// The outward-code law: compact minus the trailing 3 unit characters ("SW1A2AA" → "SW1A",
		// "BT93GS" → "BT9"). Exactly 3 — never a greedy regex, the build-side twin is `outwardOf`.
		case "GB":
			return compact.length >= MIN_GB_OUTWARD_CODE_LENGTH ? compact.slice(0, -3) : null
		// The 3-digit sectional centre ("94043" → "940"). Deliberately looser than the build side, which
		// requires a real ZIP shape: a probe for something that is not a code simply misses, and a reader
		// that re-derived the writer's validation would be a second copy of it.
		case "US":
			return compact.length >= MIN_US_SECTION_CODE_LENGTH ? compact.slice(0, 3) : null
		default:
			return null
	}
}

/**
 * The outcome of a successful prefix probe.
 */
export interface PostcodePrefixProbeResult {
	/**
	 * The prefix string that hit.
	 */
	prefix: string
	/**
	 * The index node — its `ancestors` and optional coordinate/radius are the prior's payload.
	 */
	node: PostcodePrefixNode
}

/**
 * Probe the index for `code`'s prefix. Two abstention checks, in order: the index's country must match the query's
 * country scope (or the scope is absent), and the derivation law must yield a prefix the index carries. Returns null to
 * abstain — never throws, never guesses.
 */
export function probePostcodePrefix(
	code: string,
	index: PostcodePrefixIndexLike,
	queryCountry?: string
): PostcodePrefixProbeResult | null {
	const indexCountry = index.country?.toUpperCase()

	// Country gate: the index is evidence FOR its own country only. A GB index under a US scope stays
	// silent — the walk's country filter is the caller's declared universe.
	if (queryCountry && indexCountry && queryCountry.toUpperCase() !== indexCountry) return null

	const prefix = derivePostcodePrefix(code, indexCountry)

	if (!prefix) return null

	const node = index.probe(prefix)

	return node ? { prefix, node } : null
}

/**
 * Build the synthetic `ResolvedPlace` a prefix hit resolves a `postalcode` node to. `id: 0` — it is NOT a gazetteer row
 * (the same sentinel `applyPostcodeConsistency` uses for its displaced place, resolve.ts) — and the coordinate is
 * present ONLY when the node carries one, so an ancestry-only hit stays coordinate-free by construction (B3-3's 0%
 * half).
 */
export function postcodePrefixResolvedPlace(
	prefix: string,
	node: PostcodePrefixNode,
	index: PostcodePrefixIndexLike
): CoordinateOptionalPlace {
	return {
		id: 0,
		name: prefix,
		placetype: "postalcode",
		// `""` = country unknown — the same empty-string convention the candidate backend uses for a row
		// whose country_id resolves to nothing.
		country: index.country?.toUpperCase() ?? "",
		...(node.lat !== undefined && node.lon !== undefined ? { lat: node.lat, lon: node.lon } : {}),
		score: 0,
		exactMatch: false,
	}
}
