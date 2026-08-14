/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Request-side plumbing shared by the drop-in API surfaces.
 *
 *   The drop-ins deliberately do NOT share their response envelopes — each one reproduces the wire
 *   shape of the project it replaces, and `libpostal/app.ts` records that as a free choice made on
 *   purpose. What they can share is everything upstream of the envelope: how a query string is read,
 *   how a route is described. That is what lives here.
 */

import type { Context } from "hono"

/**
 * Read the query string as Express-shaped values: a repeated key becomes an array, a single occurrence stays a scalar.
 *
 * Nominatim and Photon both accept repeated parameters and both were written against Express, so their engines expect
 * this shape rather than Hono's uniformly-array `queries()`. Built on a null-prototype object so a query key of
 * `__proto__` or `constructor` cannot reach `Object`'s prototype — these handlers take arbitrary internet input.
 */
export function legacyQuery(c: Context): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = Object.create(null)

	for (const [key, values] of Object.entries(c.req.queries())) {
		out[key] = values.length === 1 ? values[0]! : values
	}

	return out
}
