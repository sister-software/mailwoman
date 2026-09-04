/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Input coercions shared by every operation schema. An adapter hands an operation `--key value` pairs with the value
 *   still a string, or `true` for a bare flag; the schema is the one place a type is decided, so these helpers are how a
 *   flag becomes a boolean and a comma list becomes an array.
 */

import { z } from "zod"

/**
 * A boolean flag: absent → false; `--flag` → true; `--flag true|false|1|0` → as written.
 */
export const flag = z
	.union([z.boolean(), z.string()])
	.optional()
	.transform((value) => value === true || value === "true" || value === "1")

/**
 * A boolean flag that defaults to TRUE and is turned off with `--flag false`.
 */
export const flagDefaultOn = z
	.union([z.boolean(), z.string()])
	.optional()
	.transform((value) => value === undefined || value === true || value === "true" || value === "1")

/**
 * An optional string; a bare `--key` with no value is refused rather than read as the string "true".
 */
export const text = z.string().optional()

/**
 * A comma-separated list, or absent → `[]`.
 */
export const list = z
	.string()
	.optional()
	.transform((value) =>
		value
			? value
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0)
			: []
	)
