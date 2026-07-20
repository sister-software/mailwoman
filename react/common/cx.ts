/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tiny classname joiner — the only utility the presentational units need. Kept in-package (rather
 *   than pulling `classnames`) so `@mailwoman/react` ships zero runtime deps beyond its `@mailwoman/*`
 *   siblings and the React peer.
 */

export type ClassValue = string | number | false | null | undefined | Record<string, boolean>

/** Join truthy class tokens; object entries contribute their key when the value is truthy. */
export function cx(...values: ClassValue[]): string {
	const out: string[] = []

	for (const value of values) {
		if (!value) continue

		if (typeof value === "string" || typeof value === "number") {
			out.push(String(value))

			continue
		}

		for (const [key, on] of Object.entries(value)) {
			if (on) {
				out.push(key)
			}
		}
	}

	return out.join(" ")
}
