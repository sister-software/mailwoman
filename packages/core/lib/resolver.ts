/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The resolver type interface. This module holds the lookup interfaces, the placetype map and
 *   small helpers.
 *
 *   The implementation stays outside `core` to keep it a dependency-free leaf, so `core/pipeline`
 *   can compose the resolver structurally without a cycle. The implementation (`createWOFResolver`,
 *   `RemoteResolver`, span-rescore) lives in `@mailwoman/resolver`, which depends on this module
 *   plus `@mailwoman/spatial` and `@mailwoman/codex`.
 */

export {
	compareReferential,
	REFERENTIAL_LOG2_SCALE,
	REFERENTIAL_POPULATION_DIVISOR,
	REFERENTIAL_SATURATION_POPULATION,
	referentialFromPopulation,
} from "#resolver/referential"

export type { ReferentiallyRankable } from "#resolver/referential"

export { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "#resolver/postcode-format"

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

export type { RegionDatabaseProvider, RegionDatabases } from "#resolver/region-database-provider"

export {
	EMPTY_PLACE_FIELDS,
	hardCountrySafelistFromCoverage,
	RESOLVE_SWITCH_DEFAULTS,
	resolveSwitches,
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
	POIDistanceHit,
	PostcodePlace,
	PostcodePrefixAncestor,
	PostcodePrefixIndexLike,
	PostcodePrefixNode,
	ResolveCandidateTrace,
	ResolveNodeTrace,
	ResolveOpts,
	ResolveSwitches,
	DefaultCountry,
	DefaultCountrySource,
	ResolvedPlace,
	Resolver,
	ResolverBackend,
	StreetCentroidHit,
	StreetCentroidLookup,
	WeakResolutionReading,
	WOFAncestor,
} from "#resolver/types"
