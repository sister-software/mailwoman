/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One binding, several keys. A route limited by a public identifier alone lets anyone who learns it spend its
 *   owner's allowance, so the refresh and status routes hold a per-lid key and a per-address key independently and
 *   refuse when either is spent.
 */

import type { Context } from "hono"

export function clientAddress(c: Context): string {
	return c.req.header("cf-connecting-ip") ?? "unknown"
}

/**
 * Whether every key is within its allowance. Each key is charged; a request that trips one key still counts against the
 * others, which is what keeps one exhausted key from becoming a free retry on the rest.
 */
export async function withinLimits(limiter: RateLimit, keys: readonly string[]): Promise<boolean> {
	const outcomes = await Promise.all(keys.map((key) => limiter.limit({ key })))

	return outcomes.every((outcome) => outcome.success)
}
