/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Resolve a Google Maps share link to the place PIN it names, for gauntlet-case authoring.
 *
 *   The sibling clients in this package ask a geocoder where an address STRING is. This one reads a coordinate a
 *   human already picked, out of a link they already have — which is a different and often better oracle, because
 *   somebody chose that place deliberately rather than a matcher guessing at a string.
 *
 *   Same posture as the rest of the package: not truth, not a check. A share link points at whatever pin its author
 *   clicked, which may be a car park, a mall's centroid, or the wrong branch.
 *
 *   ## `!3d`/`!4d` is the pin. `@lat,lng` is NOT.
 *
 *   A resolved link carries two coordinate pairs and they are different quantities:
 *
 *       .../place/Donkey's+Place/@39.9942189,-74.792132,1062m/data=...!3d39.9933298!4d-74.7902421
 *                                ^^^^^^^^^^^^^^^^^^^^^^^ map VIEWPORT centre     ^^^^^^^^^^^^^^^^ the PLACE PIN
 *
 *   The `@` pair is where the camera sits — offset from the pin by however the view was framed, and carrying a zoom
 *   suffix. Reading it instead of `!3d`/`!4d` is a silent accuracy loss of tens to hundreds of metres, which is the
 *   whole tolerance budget of a rooftop case. So the viewport is used ONLY as a labelled fallback, and a row that
 *   fell back says so in `source` rather than blending in.
 *
 *   ## A link that does not resolve is REPORTED
 *
 *   `resolved: false` with a reason, never a coordinate of `0,0` and never a silent drop. A batch that quietly loses
 *   rows produces a case file whose denominator nobody can reconstruct.
 */

import { APIClient, type APIClientConfig, type ClockLike, systemClock } from "@mailwoman/core/api"
/**
 * Default pacing, in milliseconds between dispatches.
 *
 * This reads a public redirect on somebody else's service for the sake of authoring OUR test data, so the interval is
 * deliberately unhurried rather than tuned. `requestsPerMinute` alone does NOT hold a rate — its cooldown subtracts the
 * elapsed gap, so N alone dispatches N requests every 60/N seconds — which is why the interval is set directly.
 */
export const MAP_LINK_MIN_INTERVAL_MS = 1200

/**
 * The status range this resolver treats as a successful ANSWER: 2xx and 3xx.
 *
 * A share link answers with a REDIRECT, so the usual "2xx only" predicate would classify the one status we are here for
 * as a failure. Written as plain constants rather than taken from axios's `HttpStatusCode`, because pulling a runtime
 * dependency into this package for two integers is a worse trade than naming them.
 */
const LOWEST_ANSWERING_STATUS = 200
const FIRST_ERROR_STATUS = 400

/**
 * Where a resolved coordinate came from. The distinction is required — see the file header.
 */
export type MapLinkCoordinateSource = "place-pin" | "viewport-centre"

/**
 * One link's resolution.
 */
export interface MapLinkResolution {
	url: string
	resolved: boolean
	latitude?: number
	longitude?: number
	/**
	 * `place-pin` is the coordinate to pin. `viewport-centre` means the link carried no `!3d`/`!4d` pair and this is the
	 * camera position — usable for a coarse case, never for a rooftop tolerance.
	 */
	source?: MapLinkCoordinateSource
	/**
	 * The place name Google put in the URL path, when it carried one. Useful for catching a link that resolves to a
	 * different place than the caller believed — the failure a coordinate alone cannot show.
	 */
	name?: string
	/**
	 * The expanded URL, so a reader can audit the parse without re-fetching.
	 */
	expandedURL?: string
	reason?: string
}

/**
 * `!3d<lat>!4d<lon>` — the place pin.
 */
const PIN_PATTERN = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/
/**
 * `@<lat>,<lon>,<zoom>` — the map camera, not the place.
 */
const VIEWPORT_PATTERN = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/
/**
 * `/place/<Name>/` — Google's own label for what the link points at.
 */
const NAME_PATTERN = /\/place\/([^/@]+)/

/**
 * Parse an EXPANDED Google Maps URL. Exported separately from the fetch so the parsing rules are testable without a
 * network, which is the half that actually carries the defects.
 */
export function parseMapURL(url: string, expandedURL: string): MapLinkResolution {
	const name = NAME_PATTERN.exec(expandedURL)?.[1]
	const decodedName = name === undefined ? undefined : decodeURIComponent(name.replaceAll("+", " "))

	const pin = PIN_PATTERN.exec(expandedURL)

	if (pin) {
		return {
			url,
			resolved: true,
			latitude: Number(pin[1]),
			longitude: Number(pin[2]),
			source: "place-pin",
			...(decodedName === undefined ? {} : { name: decodedName }),
			expandedURL,
		}
	}

	const viewport = VIEWPORT_PATTERN.exec(expandedURL)

	if (viewport) {
		return {
			url,
			resolved: true,
			latitude: Number(viewport[1]),
			longitude: Number(viewport[2]),
			source: "viewport-centre",
			...(decodedName === undefined ? {} : { name: decodedName }),
			expandedURL,
			reason: "no !3d/!4d place pin in the expanded URL — this is the map CAMERA, offset from the place",
		}
	}

	return {
		url,
		resolved: false,
		expandedURL,
		reason: "the expanded URL carries neither a !3d/!4d place pin nor an @lat,lng viewport",
	}
}

/**
 * Options for {@linkcode createMapLinkResolver}.
 */
export interface CreateMapLinkResolverOptions {
	/**
	 * Milliseconds between dispatches. Defaults to {@linkcode MAP_LINK_MIN_INTERVAL_MS}.
	 */
	minRequestIntervalMs?: number
	/**
	 * Injected for tests, so timing never sleeps. See `@mailwoman/core/api/test-clocks`.
	 */
	clock?: ClockLike
}

/**
 * A paced resolver for Google Maps share links.
 *
 * Built on {@linkcode APIClient} for the same reasons its siblings are — pacing downstream of the cache, bounded retry
 * honouring `Retry-After`, and `ResourceError` mapping so a caller branches on `error.status` rather than on message
 * prose.
 */
export function createMapLinkResolver(options: CreateMapLinkResolverOptions = {}) {
	const config: APIClientConfig = {
		displayName: "Google Maps share link",
		minRequestIntervalMs: options.minRequestIntervalMs ?? MAP_LINK_MIN_INTERVAL_MS,
		clock: options.clock ?? systemClock,
	}

	const client = new APIClient(config)

	return {
		client,

		/**
		 * Resolve one link. Never throws for an unresolvable link — that is a reported row, because a batch that drops rows
		 * silently produces a case file whose denominator nobody can reconstruct.
		 */
		async resolve(url: string): Promise<MapLinkResolution> {
			try {
				// `maxRedirects: 0` — the LOCATION header is the answer. Following the redirect fetches a page we do not
				// want and would have to parse instead.
				const response = await client.fetch({
					url,
					method: "GET",
					maxRedirects: 0,
					validateStatus: (status: number) => status >= LOWEST_ANSWERING_STATUS && status < FIRST_ERROR_STATUS,
				})

				const headers = response.headers as Record<string, unknown>
				const location = (headers["location"] ?? headers["Location"]) as string | undefined

				if (!location) {
					return { url, resolved: false, reason: `no redirect Location header (status ${response.status})` }
				}

				return parseMapURL(url, location)
			} catch (error) {
				return { url, resolved: false, reason: (error as Error).message.slice(0, 160) }
			}
		},
	}
}
