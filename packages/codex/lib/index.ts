/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Per-address-system postal reference data and branded types.
 *
 *   Each address system (the USPS for the United States, La Poste for France, Deutsche Post for
 *   Germany and others) has its own conventions for a postcode, a street suffix or a unit
 *   designator. This package is the shared, dependency-free home for that reference knowledge,
 *   kept apart from the tokenizer and solver in `@mailwoman/core`.
 */

export {
	ADDRESS_SYSTEM_CONVENTIONS,
	conventionsForSystem,
	type AddressSystemConventions,
} from "#address/system-conventions"

export * from "#abbreviations"
export * from "#component"
export * from "#normalize"
export * from "#placetype-map"
export * as au from "#au"
export * as ca from "#ca"
export * as de from "#de"
export * as fr from "#fr"
export * as gb from "#gb"
export * as jp from "#jp"
export * as levels from "#level-semantics"
export * as nz from "#nz"

export {
	AREA_POSTCODE_FINER_THAN_LOCALITY,
	areaPostcodeLeadsLocality,
	candidateSystemsForPostcode,
	isUnitGradePostcodeHit,
	SYSTEM_CODES,
	type SystemCode,
	UNIT_GRADE_POSTCODE,
} from "#postcode/systems"

export * as us from "#us"
