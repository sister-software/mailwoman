/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Postcode evidence from a postcode's form: the spans in a line that have a postcode's shape, each country's
 *   postcode syntax, the countries a whole postcode's form implies, and the address systems that accept it.
 */

export { postcodeSyntax, acceptPostcode, type PostcodeSyntax } from "#country-formats"
export { normalizePostcodeDisplay } from "#display-form"
export { postcodeEvidence, PostcodeEvidenceKind, type PostcodeEvidence } from "#evidence"
export { countriesFromPostcodeFormat, countryFromPostcodeFormat } from "#postcode-format"

export {
	POSTCODE_SHAPES,
	POSTCODE_SHAPES_VERSION,
	WHOLE_POSTCODE_SHAPES,
	wholePostcodeShape,
	type PostcodeShape,
	type PostcodeShapeKind,
} from "#shapes"

export { statesSubregionPrefixes, subregionsForPostcode, type PostcodeSubregion } from "#subregions"

export {
	AREA_POSTCODE_FINER_THAN_LOCALITY,
	areaPostcodeLeadsLocality,
	candidateSystemsForPostcode,
	isUnitGradePostcodeHit,
	SYSTEM_CODES,
	UNIT_GRADE_POSTCODE,
} from "#systems"
