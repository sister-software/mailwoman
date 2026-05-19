/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import addressFormatter from "@fragaria/address-formatter"
import type { ClassificationMap, VisibleClassification } from "@mailwoman/core/classification"

type FragariaAddressProps = keyof Parameters<typeof addressFormatter.format>[0]

const ClassificationToFragaria = new Map<VisibleClassification, FragariaAddressProps>([
	["venue", "attention"],
	["street", "street"],
	["country", "country"],
	["house_number", "housenumber"],
	["locality", "locality"],
	["postcode", "postcode"],
	["region", "state"],
])

const ClassificationToSeparator = new Map<VisibleClassification, string>([
	["venue", ", "],
	["street", " & "],
	["country", ", "],
	["house_number", ", "],
	["locality", " "],
	["postcode", "-"],
	["region", ", "],
])

/**
 * Given a map of classifications, format them into a human-readable address.
 */
export function formatAddress(classifications: ClassificationMap) {
	const props = new Map<FragariaAddressProps, string>()

	for (const [classification, value] of classifications.entries()) {
		const fragariaProp = ClassificationToFragaria.get(classification)

		if (!fragariaProp) continue
		if (!value) continue
		if (props.has(fragariaProp)) continue

		const separator = ClassificationToSeparator.get(classification) || ", "

		props.set(fragariaProp, value.join(separator))
	}

	const formatted = addressFormatter.format(
		Object.fromEntries(props),

		{
			// abbreviate: true,
			// appendCountry: true,
			countryCode: "US",
			output: "array",
		}
	)

	return formatted.join(", ")
}
