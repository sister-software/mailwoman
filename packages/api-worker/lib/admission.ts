/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Admission for the API Worker's public routes: an allowed browser origin first, then a per-client request
 *   budget. A refused request costs the engine no work.
 */

import type { MiddlewareHandler } from "hono"

import { isMailwomanSiteOrigin } from "#cors"
import { jsonError } from "#errors"

/**
 * A per-key request budget, the shape of a Workers Rate Limiting binding
 * (`[[ratelimits]]` in `wrangler.toml`).
 */
export interface RequestLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>
}

/**
 * Options for {@link admitRequest}.
 */
export interface AdmissionOptions {
	/**
	 * The request budget.
	 *
	 * Without one, every request from an allowed origin is admitted.
	 */
	limiter?: RequestLimiter
	/**
	 * The budget's window in seconds, sent as `Retry-After` on a 429.
	 */
	limitPeriodSeconds: number
}

/**
 * The limiter key for a request with no `CF-Connecting-IP` header, such as one under `wrangler dev`.
 *
 * Every such request shares one budget.
 */
const UNIDENTIFIED_CLIENT = "unidentified"

/**
 * Admits a request whose `Origin` is a Mailwoman site, within its client's request budget.
 *
 * A request without an allowed `Origin` answers 403.
 * A browser always sends `Origin` on a cross-origin `POST`, so the refusal
 * turns away scripts that send no header.
 *
 * A request over its client's budget answers 429 with `Retry-After`.
 * The budget is keyed by `CF-Connecting-IP`.
 */
export function admitRequest(options: AdmissionOptions): MiddlewareHandler {
	return async (c, next) => {
		const origin = c.req.header("origin")

		if (!origin || !isMailwomanSiteOrigin(origin)) return jsonError(403, "origin not allowed")

		// TODO: A script can send a forged `Origin` header, so the check above refuses
		// only clients that send none or the wrong one.
		// A signed request token would tell a browser session from such a script: an HMAC over the path,
		// a timestamp and the page origin, under a key the Worker holds, issued by the Earth build
		// or by a short-lived token route, and checked here before the budget is spent.

		if (options.limiter) {
			const key = c.req.header("cf-connecting-ip") ?? UNIDENTIFIED_CLIENT
			const { success } = await options.limiter.limit({ key })

			if (!success) {
				return jsonError(429, "rate limited", { "Retry-After": String(options.limitPeriodSeconds) })
			}
		}

		await next()
	}
}
