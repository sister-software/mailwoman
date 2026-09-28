/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   This module defines the synchronous street-tier lookup interfaces used by the resolution ladder.
 *   The ladder checks address points and interpolation results.
 *   It also checks street centroids and postcode prefixes.
 *   These interfaces stay synchronous because `@mailwoman/neural` calls into the ladder.
 *   Making one member asynchronous would require asynchronous implementers and package boundaries.
 */

/**
 * One exact address-point hit, a real situs coordinate for `(street, number)`
 * within a postcode or locality scope.
 *
 * This is the street-level tier in front of admin-centroid resolution.
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
	 * The point's own scope tags, when the extract row carries them.
	 *
	 * These hold the register's locality in normalized key form and its postcode.
	 *
	 * The resolver can then decorate a rooftop answer with the commune and postcode attested by the register.
	 * A query that never carried those values cannot supply them.
	 * Optional, because not every source carries both.
	 */
	localityNorm?: string
	postcode?: string
}

/**
 * Street-level exact-point lookup.
 *
 * Implementations own their normalization.
 * Both the extract build and this lookup must apply the same normalizer
 * (see `resolver-wof-sqlite/street-normalize.ts`).
 * Core depends only on this interface.
 */
export interface AddressPointLookup {
	find(query: {
		street: string
		number: string
		postcode?: string
		locality?: string
		/**
		 * The parse's `region` and `subregion` spans, for a register whose rows
		 * carry neither postcode nor locality.
		 *
		 * The Taiwanese register scopes a point by 縣市 and 鄉鎮市區 (`臺北市` / `中正區`),
		 * which the parse tags `region` and `subregion`.
		 * A reader built on that register composes its locality key from the pair.
		 *
		 * Every other reader ignores both, so the Latin path is byte-stable.
		 */
		region?: string
		subregion?: string
		/**
		 * Optional bbox scope (`minLat`/`maxLat`/`minLon`/`maxLon`), tried after postcode and locality.
		 *
		 * For extracts whose points carry no postcode or locality of their own
		 * (many OSM addr nodes do not) but do carry a coordinate, the resolved locality's
		 * bounding box scopes the `(street, number)` probe instead.
		 * US situs never passes it, so the Latin path stays byte-stable.
		 */
		bbox?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
	}): AddressPointHit | null
}

/**
 * One interpolated coordinate estimate, never an exact situs point.
 * `uncertaintyM` prices the estimate honestly.
 *
 * A structural mirror of `InterpolatedHit` in `resolver-wof-sqlite/interpolation.ts`.
 * Keep this a subset of that shape so the concrete `StreetInterpolator`
 * and `AddressPointInterpolator` satisfy {@link InterpolationLookup} with no adapter,
 * following the {@link AddressPointHit} precedent.
 */
export interface InterpolatedPointHit {
	lat: number
	lon: number
	interpolated: true
	/**
	 * `address_point` is bracketed between real neighbor points.
	 * `tiger_range` is linear within a segment range.
	 */
	method: "address_point" | "tiger_range"
	/**
	 * False when only the opposite side's range contained the number (right block, wrong side).
	 */
	parityMatched?: boolean
	/**
	 * `both` means neighbors bracketed it.
	 *
	 * `single` means one-sided extrapolation with larger uncertainty.
	 */
	bracket?: "both" | "single"
	/**
	 * Honest uncertainty radius in meters (half the matched segment length).
	 */
	uncertaintyM: number
	source: string
	release: string
}

/**
 * House-number interpolation lookup.
 *
 * Like {@link AddressPointLookup}, implementations own their normalization
 * (the shared `resolver-wof-sqlite/street-normalize.ts`).
 * Core depends only on this interface.
 *
 * Postcode-scoped.
 * Without a postcode the tier answers only when the covering ranges agree on one postcode.
 *
 * `near`, the resolved locality's coordinate, lets an implementation break a
 * multi-postcode tie by segment proximity instead of abstaining.
 *
 * Optional and advisory, so implementations may ignore it.
 */
export interface InterpolationLookup {
	find(query: {
		street: string
		number: string
		postcode?: string
		near?: { lat: number; lon: number }
	}): InterpolatedPointHit | null
	/**
	 * The artifact's own conformal radius multiplier for `uncertaintyM`, read from the
	 * extract's `interp_calibration` metadata table at open time.
	 *
	 * The multiplier is a property of the calibration set the artifact was built against,
	 * so it ships in the artifact.
	 * The resolver applies it as the default whenever `ResolveOpts.interpolationRadiusCalibration` is absent.
	 *
	 * `undefined` means the artifact carries no multiplier.
	 * An implementation without the property also reports no multiplier.
	 *
	 * Extracts built before the metadata table existed use that behavior.
	 * The ladder then uses the caller-supplied factor or raw value, as before.
	 *
	 * Implementations must read this at open time (constructor/factory), never per-lookup.
	 * `find()` is synchronous by design.
	 */
	readonly radiusCalibration?: number
}

/**
 * One street-centroid hit, the street-level tier below the exact address-point tier
 * and above admin-centroid resolution.
 *
 * A street's centroid and an honest extent-derived radius, for a street-only query with no house number.
 * An address-point tier cannot serve that query.
 *
 * Derived from a national register's rooftop points in `street-centroids-<cc>.db`,
 * a `group BY street` roll-up.
 *
 * `uncertaintyM` prices the coarseness as half the street's bbox diagonal,
 * so a consumer never mistakes it for a rooftop.
 */
export interface StreetCentroidHit {
	lat: number
	lon: number
	/**
	 * Honest coarse radius in meters, half the street's bounding-box diagonal.
	 */
	uncertaintyM: number
	source: string
	release: string
}

/**
 * Street-centroid lookup.
 *
 * Like {@link AddressPointLookup}, implementations own their normalization
 * (the shared `resolver-wof-sqlite/street-normalize.ts`).
 * Core depends only on this interface.
 *
 * Scoped by `postcode` (preferred) or `locality`, the base commune.
 * This is the street-only tier, so it takes no house number.
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
 * A PFX1 postcode-prefix node, the partial-code prior's payload ({@link ResolveOpts.postcodePrefixPrior}).
 *
 * The coordinate is optional and its absence is meaningful.
 * An ancestry-only tier such as Northern Ireland's BT districts carries `ancestors` and no `lat`/`lon`.
 *
 * The type represents that omission as absence.
 * `radiusP95Km` is mandatory whenever a coordinate is present, because a 1-digit US band
 * and a GB outward code are both a prefix with a centroid and differ by 200×.
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
 * The PFX1 index the resolver probes, minimal and structural (`probe` plus optional `country`),
 * so `@mailwoman/resolver` consumes an index built in `@mailwoman/neural` without depending on it.
 *
 * `country` is the ISO-3166 alpha-2 the index was built for, in upper case.
 * The resolver only probes an index whose country matches the query's country scope.
 */
export interface PostcodePrefixIndexLike {
	probe(prefix: string): PostcodePrefixNode | null
	readonly country?: string
}
