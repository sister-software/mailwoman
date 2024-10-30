/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import removeAccents from "remove-accents"

interface NormalizerOptions {
	lowercase?: boolean
	removeAccents?: boolean
	removeHyphen?: boolean
	removeSpaces?: boolean
}

/**
 * Create a normalizer function.
 */
function createNormalizer(options: NormalizerOptions = {}) {
	return (value: string): string => {
		value = value.trim()
		if (options.lowercase) {
			value = value.toLowerCase()
		}
		if (options.removeAccents) {
			value = removeAccents(value)
		}
		if (options.removeHyphen) {
			value = value.replace(/-/g, " ")
		}
		if (options.removeSpaces) {
			value = value.replace(/ /g, "")
		}
		return value
	}
}

export default createNormalizer
