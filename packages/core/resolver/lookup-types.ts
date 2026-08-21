/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The SYNCHRONOUS street-tier lookup contracts the resolution ladder is built on — address point,
 *   interpolation, street centroid, postcode prefix. Synchronous by design: `@mailwoman/neural` calls into this
 *   ladder, so turning one member async forces every implementer and both package boundaries async with it.
 */

/**
 * One exact address-point hit (#476): a real situs coordinate for `(street, number)` within a postcode/locality scope —
 * the street-level tier in front of admin-centroid resolution.
 */
export interface AddressPointHit {
	lat: number
	lon: number
	/**
	 * Provenance, e.g. `"overture:NAD"`.
	 */
	source: string
	/**
	 * Pinned data release the point came from, e.g. `"2026-05-20.0"`.
	 */
	release: string
	/**
	 * The point's OWN scope tags, when the shard row carries them — the register's locality (normalized key form) and
	 * postcode. A rooftop answer can then be DECORATED with the commune/postcode the register attests, which a query that
	 * never named them cannot supply. Optional: not every source carries both, and existing readers/consumers predate the
	 * fields.
	 */
	localityNorm?: string
	postcode?: string
}

/**
 * Street-level exact-point lookup (#476). Implementations own their normalization — both the shard build and this
 * lookup must apply the SAME normalizer (see `resolver-wof-sqlite/street-normalize.ts`). Core depends only on this
 * contract.
 */
export interface AddressPointLookup {
	find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
		/**
		 * Optional bbox scope (`minLat`/`maxLat`/`minLon`/`maxLon`), tried AFTER postcode/locality. For shards whose points
		 * carry no postcode/locality of their own (OSM addr nodes often don't) but DO carry a coordinate — the resolved
		 * locality's bounding box scopes the `(street, number)` probe instead. US situs never passes it (byte-stable).
		 */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	}): AddressPointHit | null
}

/**
 * One interpolated coordinate estimate (#483) — NEVER an exact situs point (`uncertaintyM` prices the estimate
 * honestly). Structural mirror of `InterpolatedHit` in `resolver-wof-sqlite/interpolation.ts`; keep this a SUBSET of
 * that shape so the concrete `StreetInterpolator`/`AddressPointInterpolator` satisfy {@link InterpolationLookup} with no
 * adapter (the {@link AddressPointHit} precedent).
 */
export interface InterpolatedPointHit {
	lat: number
	lon: number
	interpolated: true
	/**
	 * `address_point` = bracketed between real neighbor points; `tiger_range` = linear within a segment range.
	 */
	method: "address_point" | "tiger_range"
	/**
	 * False when only the opposite side's range contained the number (right block, wrong side).
	 */
	parityMatched?: boolean
	/**
	 * `both` = neighbors bracketed it; `single` = one-sided extrapolation (larger uncertainty).
	 */
	bracket?: "both" | "single"
	/**
	 * Honest uncertainty radius in METERS (half the matched segment length).
	 */
	uncertaintyM: number
	source: string
	release: string
}

/**
 * House-number interpolation lookup (#483). Like {@link AddressPointLookup}, implementations own their normalization
 * (the shared `resolver-wof-sqlite/street-normalize.ts`); core depends only on this contract. Postcode-scoped; without
 * a postcode the tier answers only when the covering ranges agree on ONE postcode — `near` (the resolved locality's
 * coordinate) lets an implementation break a multi-postcode tie by segment proximity instead of abstaining (the
 * Brooklyn-vs-Great-Neck namesake class). Optional and advisory: implementations may ignore it.
 */
export interface InterpolationLookup {
	find(query: {
		street: string
		number: string
		postcode?: string
		near?: { lat: number; lon: number }
	}): InterpolatedPointHit | null
	/**
	 * The ARTIFACT's own conformal radius multiplier for `uncertaintyM` (#374), read from the shard's
	 * `interp_calibration` metadata table at open time (the pair-index δ/transitionBeta header precedent): the multiplier
	 * is a property of the calibration set the artifact was built against, so it ships in the artifact, not in caller
	 * code. The resolver applies it as the DEFAULT whenever `ResolveOpts.interpolationRadiusCalibration` is absent.
	 * `undefined` (or an implementation without the property) = the artifact carries none — shards built before the
	 * metadata table existed; behavior is then exactly the pre-artifact ladder (caller-supplied factor or raw).
	 * Implementations must read this at OPEN time (constructor/factory), never per-lookup — `find()` is synchronous by
	 * design.
	 */
	readonly radiusCalibration?: number
}

/**
 * One street-CENTROID hit (#1042) — the street-level tier BELOW the exact address-point tier and ABOVE admin-centroid
 * resolution. A street's centroid + an honest extent-derived radius, for a street-only query (no house number) that an
 * address-point tier cannot serve by definition. Derived from a national register's rooftop points
 * (`street-centroids-<cc>.db`, a `GROUP BY street` roll-up). `uncertaintyM` prices the coarseness (half the street's
 * bbox diagonal) so a consumer never mistakes it for a rooftop.
 */
export interface StreetCentroidHit {
	lat: number
	lon: number
	/**
	 * Honest coarse radius in METERS — half the street's bounding-box diagonal.
	 */
	uncertaintyM: number
	source: string
	release: string
}

/**
 * Street-centroid lookup (#1042). Like {@link AddressPointLookup}, implementations own their normalization (the shared
 * `resolver-wof-sqlite/street-normalize.ts`); core depends only on this contract. Scoped by `postcode` (preferred) or
 * `locality` (the base commune) — NO house number: this is the street-only tier.
 */
export interface StreetCentroidLookup {
	find(query: { street: string; postcode?: string; locality?: string }): StreetCentroidHit | null
}

/**
 * One admin-ancestry entry a PFX1 node asserts (coarsest-first: country → constituent country → district).
 */
export interface PostcodePrefixAncestor {
	placetype: string
	wofID: number
	name: string
}

/**
 * A PFX1 postcode-prefix node — the partial-code prior's payload ({@link ResolveOpts.postcodePrefixPrior}, #31
 * Mechanism 3). The coordinate is OPTIONAL and its absence is meaningful: an ancestry-only tier (NI's 80 BT districts)
 * carries `ancestors` and no `lat`/`lon` — representable as absence, never as `0,0` (the meaning-of-zero rule).
 * `radiusP95Km` is mandatory whenever a coordinate is present (M-3's receipt: a 1-digit US band and a GB outward code
 * are both "a prefix with a centroid" and differ by 200×).
 */
export interface PostcodePrefixNode {
	prefix: string
	ancestors: readonly PostcodePrefixAncestor[]
	lat?: number
	lon?: number
	radiusP95Km?: number
	unitCount: number
}

/**
 * The PFX1 index the resolver probes — minimal, structural (`probe` + optional `country`), so `@mailwoman/resolver`
 * consumes an index built in `@mailwoman/neural` without depending on it (B3-5: the partial-code prior touches zero
 * model inputs). `country` is the ISO-3166 alpha-2 the index was built for (upper-case); the resolver only probes an
 * index whose country matches the query's country scope.
 */
export interface PostcodePrefixIndexLike {
	probe(prefix: string): PostcodePrefixNode | null
	readonly country?: string
}
