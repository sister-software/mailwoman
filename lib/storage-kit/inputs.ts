/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Input coercions shared by the storage operation schemas. An adapter hands an operation `--key value` pairs with
 *   the value still a string, so the schema is where a comma list becomes an array.
 */

import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { z } from "zod"

/**
 * A comma-separated list from the command line, or an array passed directly by a programmatic caller.
 *
 * Without this a `z.array` input is unreachable from the CLI, because every option arrives as a string.
 */
export function commaList(fallback: readonly string[]) {
	return z
		.union([z.string(), z.array(z.string())])
		.optional()
		.transform((value) => {
			if (value === undefined) return [...fallback]

			if (Array.isArray(value)) return [...value]

			return [...extractDelimited(value)]
		})
}
