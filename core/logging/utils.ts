/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */
/**
 * Casts an object to an array of log-friendly entries.
 *
 * @category Object
 * @category Logger
 */
export function castToLoggableEntries<T extends Record<string, unknown>>(input: T) {
	return Object.entries(input)
		.sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
		.filter(([_key, value]) => value && typeof value === "string") as [keyof T, string][]
}

/**
 * Options for pretty-printing a logged object.
 *
 * @category Logger
 * @internal
 */
export interface StringifyLoggedObjectOptions {
	description: string
	showValues?: boolean
}

/**
 * Pretty-prints the public environment variables.
 *
 * @category Object
 * @category Logger
 */
export function stringifyLoggedObject(
	input: Record<string, unknown>,
	{ description, showValues }: StringifyLoggedObjectOptions
): string {
	const lines = castToLoggableEntries(input).map(([key, value]) => {
		const printedValue = showValues ? value : new Array(value.length).fill("*").join("")

		return `${key}: ${printedValue}`
	})

	return description + "\n\n" + lines.join("\n") + "\n"
}
