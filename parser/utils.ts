/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import addressFormatter from "@fragaria/address-formatter"
import { ClassificationMap, ClassificationRecord, PublicClassificationLabel } from "../classification/types.js"
import { Tokenizer } from "../tokenization/Tokenizer.js"
import { AddressParser } from "./AddressParser.js"

type FragariaAddressProps = keyof Parameters<typeof addressFormatter.format>[0]

const ClassificationToFragaria = new Map<PublicClassificationLabel, FragariaAddressProps>([
	["venue", "attention"],
	["street", "street"],
	["country", "country"],
	["housenumber", "housenumber"],
	["locality", "locality"],
	["postcode", "postcode"],
	["region", "state"],
])

export function formatAddress(classifications: ClassificationMap) {
	const props = new Map<FragariaAddressProps, string>()

	for (const [classification, value] of classifications.entries()) {
		const fragariaProp = ClassificationToFragaria.get(classification)

		if (!fragariaProp) continue
		if (!value) continue
		if (props.has(fragariaProp)) continue

		props.set(fragariaProp, value)
	}

	const formatted = addressFormatter.format(
		Object.fromEntries(props),
		// {
		// 	attention: classifications.venue,
		// 	street: classifications.street,
		// 	country: classifications.country,
		// 	housenumber: classifications.housenumber,
		// 	locality: classifications.locality,
		// 	postcode: classifications.postcode,
		// 	state: classifications.region,
		// 	// level: classifications.level,
		// 	// level_type: classifications.level_type,
		// 	// region: classifications.region,
		// 	// unit: classifications.unit,
		// 	// unit_type: classifications.unit_type,
		// 	// venue: classifications.venue,
		// },
		{
			// abbreviate: true,
			// appendCountry: true,
			countryCode: "US",
			output: "array",
		}
	)

	return formatted.join(", ")
}

export interface ParsedAddress {
	classifications: ClassificationRecord
	formatted_address: string
}

/**
 * Parse an address input, preferably a well-formatted address.
 */
export function parseAddressInput(formattedAddress: string): ParsedAddress[] {
	const tokenizer = new Tokenizer(formattedAddress)
	const parser = new AddressParser()

	parser.classify(tokenizer)
	parser.solve(tokenizer)

	const results: ParsedAddress[] = tokenizer.solutions.map(({ pair }) => {
		const classifications: ClassificationMap = new Map()

		for (const { classification, span } of pair) {
			classifications.set(classification.label as PublicClassificationLabel, span.body)
		}

		return {
			classifications: Object.fromEntries(classifications) as ClassificationRecord,
			formatted_address: formatAddress(classifications),
		}
	})

	return results
}
