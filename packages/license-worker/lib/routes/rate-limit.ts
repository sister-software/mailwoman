/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   One binding, several keys. A route limited only by a public identifier lets anyone who learns it spend its
 *   owner's allowance, so the refresh and status routes hold a per-lid key and a per-address key independently and
 *   refuse when either is spent.
 */

import type { RateLimit } from "@cloudflare/workers-types"
import type { Context } from "hono"

export function clientAddress(c: Context): string {
	return c.req.header("cf-connecting-ip") ?? "unknown"
}

/**
 * Whether every key is within its allowance.
 *
 * Each key is charged.
 * A request that trips one key still counts against the others.
 *
 * This keeps one exhausted key from becoming a free retry on the rest.
 */
export async function withinLimits(limiter: RateLimit, keys: readonly string[]): Promise<boolean> {
	const results = await Promise.all(keys.map((key) => limiter.limit({ key })))

	return results.every((result) => result.success)
}
