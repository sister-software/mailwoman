/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * Address field codes.
 */
export const AddressFieldCode = {
	Name: "N",
	Organisation: "O",
	StreetAddressLine: "A",
	/**
	 * May be an inner-city district or a suburb
	 */
	DependentLocality: "D",
	CityOrLocality: "C",
	/**
	 * State, province, island etc.
	 *
	 * Indicates as to the data expected can be read from the `state_name_type` field.
	 *
	 * If this is missing, it is assumed to be "province" - but it may be overridden with values such
	 * as "state", "island" etc.
	 */
	AdministrativeArea: "S",
	ZipOrPostalCode: "Z",
	SortingCode: "X",
} as const satisfies Record<string, string>

export type AddressFieldCode = (typeof AddressFieldCode)[keyof typeof AddressFieldCode]

export interface PostcodeSpec {
	/**
	 * Example postcodes, delimited by a comma.
	 */
	zipex: string
	/**
	 * Required fields.
	 *
	 * @see {@linkcode AddressFieldCode}
	 */
	require: string
	/**
	 * URL to lookup the postcode.
	 */
	posturl: string
	/**
	 * - ISO 3166-1 alpha-2 country code.
	 */
	key: string
	/**
	 * Country name.
	 */
	name: string
	/**
	 * Format of the address.
	 */
	fmt: string
	/**
	 * Type of the postcode.
	 */
	zip_name_type: string
	/**
	 * Subdivision names.
	 */
	sub_names: string
	/**
	 * Subdivision example postcodes.
	 */
	sub_zipexs: string
	/**
	 * Language code.
	 */
	lang: string
	/**
	 * Subdivision ISO codes.
	 */
	sub_isoids: string
	/**
	 * Type of the state name.
	 */
	state_name_type: string
	/**
	 * Regex pattern for the postcode.
	 */
	zip: string
	/**
	 * Subdivision keys.
	 */
	sub_keys: string
	/**
	 * Languages.
	 */
	languages: string
	/**
	 * Uppercase fields.
	 */
	upper: string
	/**
	 * Subdivision postcodes.
	 */
	sub_zips: string
}
