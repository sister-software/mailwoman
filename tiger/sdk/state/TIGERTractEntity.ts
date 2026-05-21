/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { AdminLevel1Code, type FIPSCountyCode, type FIPSTractCode } from "@mailwoman/tiger"

/**
 * @internal
 */
export interface TIGERTractShapeAttributes {
	/**
	 * @title State FIPS Code
	 */
	STATEFP: AdminLevel1Code

	/**
	 * @title County FIPS Code
	 * @minLength 3
	 * @maxLength 3
	 * @pattern ^\d{3}$
	 */
	COUNTYFP: FIPSCountyCode

	/**
	 * @title Tract FIPS Code
	 *
	 * @minLength 6
	 * @maxLength 6
	 * @pattern ^\d{6}$
	 */
	TRACTCE: FIPSTractCode
}
