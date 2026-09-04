/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Clock-to-string helpers shared by the artifact builders.
 */

/**
 * The UTC calendar date as `YYYY-MM-DD`.
 */
export function isoDate(now: Date = new Date()): string {
	return now.toISOString().slice(0, 10)
}

/**
 * The UTC instant at second precision with an explicit `+00:00` offset — the shape Python's
 * `datetime.isoformat(timespec="seconds")` writes, so a manifest built here and one built by the training code compare
 * equal.
 */
export function isoSecondsUTC(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "+00:00")
}

/**
 * The UTC instant at second precision with the `Z` suffix — the RFC 3339 shape the artifact manifests and eval reports
 * stamp.
 */
export function isoSeconds(now: Date = new Date()): string {
	return now.toISOString().replace(/\.\d{3}Z$/, "Z")
}
