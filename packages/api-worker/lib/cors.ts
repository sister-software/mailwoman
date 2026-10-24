/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The browser origins Mailwoman's Workers answer, and the CORS middleware both Workers mount.
 *
 *   The API Worker and the tile Worker share one origin list, so a site added here can call both. A Worker that
 *   also answers a third-party page, as the tile Worker answers the MapLibre style editor, passes that origin in
 *   `alsoAllow` instead of widening the shared list.
 */

import type { MiddlewareHandler } from "hono"
import { cors } from "hono/cors"

/**
 * The Mailwoman sites, production and development, that may call a Mailwoman Worker from a browser.
 */
export const MAILWOMAN_SITE_ORIGINS: ReadonlySet<string> = new Set([
	"https://mailwoman.ai",
	"https://earth.mailwoman.ai",
	"https://moon.mailwoman.ai",
	"https://mars.mailwoman.ai",
	"https://mailwoman.sister.software",
	"https://sister.software",
	"https://dev.mailwoman.ai",
	"https://dev.mailwoman.ai:7777",
	"https://dev.mailwoman.ai:8888",
	"http://dev.mailwoman.ai:7777",
	"http://dev.mailwoman.ai:8888",
])

/**
 * A page served from this machine during development: `localhost`, a `*.localhost` name,
 * or `127.0.0.1`, on any port.
 */
const LOCAL_DEVELOPMENT_ORIGIN = /^https?:\/\/(([a-z0-9]+\.)?localhost|127\.0\.0\.1)(:\d{2,5})?$/i

/**
 * Reports whether `origin` is a Mailwoman site or a local development page.
 */
export function isMailwomanSiteOrigin(origin: string): boolean {
	return MAILWOMAN_SITE_ORIGINS.has(origin) || LOCAL_DEVELOPMENT_ORIGIN.test(origin)
}

/**
 * Options for {@link mailwomanCORS}.
 */
export interface MailwomanCORSOptions {
	allowMethods: string[]
	/**
	 * The request headers a preflight admits.
	 */
	allowHeaders: string[]
	/**
	 * The response headers a page's script may read.
	 */
	exposeHeaders: string[]
	/**
	 * How long a browser may reuse a preflight answer, in seconds.
	 *
	 * @defaultValue one day
	 */
	maxAge?: number
	/**
	 * Origins this Worker answers beyond the Mailwoman sites.
	 */
	alsoAllow?: (origin: string) => boolean
}

const ONE_DAY_SECONDS = 86_400

/**
 * CORS middleware that answers the Mailwoman sites, plus the origins `alsoAllow` admits.
 *
 * A response to any other origin, or to a request without an `Origin` header,
 * has no `Access-Control-Allow-Origin` header, so a browser withholds it from the page.
 */
export function mailwomanCORS(options: MailwomanCORSOptions): MiddlewareHandler {
	const { alsoAllow } = options

	return cors({
		origin: (origin) => (isMailwomanSiteOrigin(origin) || alsoAllow?.(origin) ? origin : null),
		allowMethods: options.allowMethods,
		allowHeaders: options.allowHeaders,
		exposeHeaders: options.exposeHeaders,
		maxAge: options.maxAge ?? ONE_DAY_SECONDS,
	})
}
