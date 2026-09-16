/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Request-side plumbing shared by the drop-in API surfaces.
 *
 *   Drop-ins keep their response envelopes but share query-string and route plumbing.
 */

import type { Context } from "hono"

/**
 * A non-empty string query value, else `undefined`. An empty `?q=` is treated as absent, since every drop-in reads it
 * that way.
 */
export function asString(raw: unknown): string | undefined {
	return typeof raw === "string" && raw.length ? raw : undefined
}

/**
 * Read the query string as scalar-or-array values on a null-prototype object.
 */
export function legacyQuery(c: Context): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = Object.create(null)

	for (const [key, values] of Object.entries(c.req.queries())) {
		out[key] = values.length === 1 ? values[0]! : values
	}

	return out
}
