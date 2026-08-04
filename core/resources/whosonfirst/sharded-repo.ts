/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Reading a place out of a cloned Who's On First data repo.
 *
 *   WOF stores each record at a path derived from its own id: the decimal id split into three-character directories,
 *   then `<id>.geojson`. `85977539` lives at `859/775/39/85977539.geojson`. The rule is not written down in the data —
 *   it is layout knowledge every reader has to carry — so it lives here once, next to the {@link WOFFeature} type the
 *   parsed record has.
 */

import { existsSync, readFileSync } from "node:fs"

import { resolvePath } from "path-ts"

import { tryParsingJSON } from "../../objects.ts"
import type { WOFFeature } from "./placetypes/admin.ts"

/**
 * Characters per directory level. A trailing group shorter than this is its own directory — `85977539` ends in `39`,
 * not `390`.
 */
const ID_CHUNK = 3

/**
 * A WOF id → its repo-relative path segments, ending in `<id>.geojson`.
 *
 * Segments rather than a joined string so a caller can append them to whatever root it already holds — the repos layout
 * puts a `data` directory under each `whosonfirst-data-*` clone, and callers reach it differently.
 */
export function wofIDPathSegments(id: number): string[] {
	const digits = String(id)
	const segments: string[] = []

	for (let i = 0; i < digits.length; i += ID_CHUNK) {
		segments.push(digits.slice(i, i + ID_CHUNK))
	}

	segments.push(`${digits}.geojson`)

	return segments
}

/**
 * Read a place's GeoJSON from the first `root` that holds it, or `null` when no root does or the file will not parse.
 *
 * `null` conflates "absent" with "unparseable" on purpose: every caller so far treats both as "no evidence for this
 * place" and continues. A caller that needs to tell them apart should read the file itself.
 */
export function readWOFFeature(id: number, roots: readonly string[]): WOFFeature | null {
	const segments = wofIDPathSegments(id)

	for (const root of roots) {
		const path = resolvePath(root, ...segments)

		if (!existsSync(path)) continue

		try {
			return tryParsingJSON<WOFFeature>(readFileSync(path, "utf8"))
		} catch {
			// The file vanished or turned unreadable between existsSync and the read — same "no evidence" verdict.
			return null
		}
	}

	return null
}
