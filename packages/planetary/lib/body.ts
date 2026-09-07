/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Which body this build is for. The value is compiled into the client at build time, so a running app never reads
 *   configuration to learn its body, and a production host serving the wrong body's build fails at startup rather
 *   than showing the other world.
 */

/**
 * The bodies the app is built for, in the order the pipeline publishes them.
 */
export const PLANETARY_BODIES = ["moon", "mars"] as const

export type PlanetaryBody = (typeof PLANETARY_BODIES)[number]

/**
 * Injected by the Vite `define` from `PLANETARY_BODY` at build time; a source run outside Vite has no value.
 */
declare const __PLANETARY_BODY__: PlanetaryBody

/**
 * The body this build was compiled for.
 */
export function currentBody(): PlanetaryBody {
	return __PLANETARY_BODY__
}

const PRODUCTION_HOSTS: Record<PlanetaryBody, string> = {
	moon: "moon.mailwoman.ai",
	mars: "mars.mailwoman.ai",
}

/**
 * The body a production hostname serves, or null for any other host: a preview deployment, localhost, a custom domain
 * still being set up.
 */
export function bodyForHostname(hostname: string): PlanetaryBody | null {
	for (const body of PLANETARY_BODIES) {
		if (PRODUCTION_HOSTS[body] === hostname) return body
	}

	return null
}

/**
 * A production host must serve its own body's build. Any other host serves either, so the check only fires when the
 * hostname is one of the two production names, and the error names both sides so the misconfigured project is
 * identifiable from the message alone.
 */
export function assertHostMatchesBody(hostname: string, body: PlanetaryBody): void {
	const expected = bodyForHostname(hostname)

	if (expected && expected !== body) {
		throw new Error(`${hostname} serves the ${expected} app, but this build is for ${body}`)
	}
}
