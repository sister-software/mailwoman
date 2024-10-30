/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * WhosOnFirst placetypes are a hierarchical classification system for geographic features.
 *
 * @see {@link https://github.com/whosonfirst/whosonfirst-placetypes/blob/main/data/placetypes-spec-latest.json | WhosOnFirst Placetypes}
 */
export type WhosOnFirstPlacetype =
	| "country"
	| "continent"
	| "region"
	| "county"
	| "locality"
	| "neighbourhood"
	| "microhood"
	| "macrohood"
	| "venue"
	| "building"
	| "address"
	| "campus"
	| "empire"
	| "planet"
	| "dependency"
	| "disputed"
	| "metroarea"
	| "timezone"
	| "localadmin"
	| "macroregion"
	| "macrocounty"
	| "ocean"
	| "marinearea"
	| "borough"
	| "postalcode"
	| "intersection"
	| "wing"
	| "concourse"
	| "arcade"
	| "enclosure"
	| "installation"
	| "marketarea"
	| "custom"
	| "nation"
	| "postalregion"
