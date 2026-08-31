/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolver TYPE CONTRACT — `ResolverBackend`, `Resolver`, `ResolveOpts`, `ResolvedPlace`, the
 *   lookup interfaces, the placetype map. Pure types + tiny helpers; NO implementation, so `core`
 *   stays a dependency-free leaf and `core/pipeline` can compose the resolver structurally without
 *   a cycle. The IMPLEMENTATION (`createWOFResolver`, `RemoteResolver`, span-rescore) lives in
 *   `@mailwoman/resolver` (#215), which depends on this + `@mailwoman/spatial` +
 *   `@mailwoman/codex`.
 */

export {
	compareReferential,
	REFERENTIAL_LOG2_SCALE,
	REFERENTIAL_POPULATION_DIVISOR,
	REFERENTIAL_SATURATION_POPULATION,
	referentialFromPopulation,
} from "#resolver/referential"

export type { ReferentiallyRankable } from "#resolver/referential"

export {
	countriesFromPostcodeFormat,
	countryFromPostcodeFormat,
	POSTCODE_FORMAT_COUNTRY,
} from "#resolver/postcode-format"

export { AuthoritativeMatchStatus, AuthoritativeResponseStatus } from "#resolver/authoritative-provider"

export type {
	AuthoritativeMatch,
	AuthoritativeProvider,
	AuthoritativeQuery,
	AuthoritativeQueryComponent,
	AuthoritativeResponse,
} from "#resolver/authoritative-provider"

export {
	createFixtureAuthoritativeProvider,
	fixtureExactMatch,
	type FixtureAuthoritativeProviderOptions,
	type FixtureAuthoritativeRule,
} from "#resolver/fixture-authoritative-provider"

export {
	DEFAULT_PLACETYPE_MAP,
	PLACETYPE_FILTER_GROUPS,
	expandPlacetypeFilter,
	hardCountrySafelistFromCoverage,
	isPlacetypeFallback,
} from "#resolver/types"

export type {
	AddressPointHit,
	AddressPointLookup,
	Ancestor,
	BackendCapabilityGap,
	CoincidentLocality,
	CountryBBoxFact,
	CountryCoverageFact,
	GazetteerArtifactCoverage,
	InterpolatedPointHit,
	InterpolationLookup,
	PlacetypeMap,
	PostcodePrefixAncestor,
	PostcodePrefixIndexLike,
	PostcodePrefixNode,
	ResolveCandidateTrace,
	ResolveNodeTrace,
	ResolveOpts,
	ResolvedPlace,
	Resolver,
	ResolverBackend,
	StreetCentroidHit,
	StreetCentroidLookup,
} from "#resolver/types"
