/**
 * @copyright Sister Software
 */

export interface USTuple {
	house_number: string
	street: string
	locality: string
	region: string
	postcode: string
}

export interface FRTuple {
	house_number: string
	street: string
	locality: string
	postcode: string
}

export interface AUTuple {
	locality: string
	region: string
	postcode: string
}

export interface NZTuple {
	locality: string
	postcode: string
}

export interface Rendered {
	fmt: string
	raw: string
	components: Record<string, string>
}
