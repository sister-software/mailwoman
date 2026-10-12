/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

/**
 * The separator OSM mappers use between the language forms of one name, as in `Heol y Wig / Pier Street`.
 *
 * The spaces are part of it, so a house range such as `1/2` or a name such as `A/B Road` stays whole.
 */
const NAME_FORM_SEPARATOR = " / "

/**
 * The street names an OSM `addr:street` value answers to: the value itself and,
 * when it joins several language forms with ` / `, each form on its own.
 *
 * A query names one form, so a rooftop row keyed only on the joined value matches neither.
 */
export function streetNameForms(street: string): string[] {
	if (!street.includes(NAME_FORM_SEPARATOR)) return [street]

	const forms = street
		.split(NAME_FORM_SEPARATOR)
		.map((form) => form.trim())
		.filter(Boolean)

	return [...new Set([street, ...forms])]
}
