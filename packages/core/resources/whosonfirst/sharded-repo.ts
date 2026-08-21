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

import { existsSync, readFileSync, statSync } from "node:fs"

import { resolvePath } from "path-ts"

import { tryParsingJSON } from "#objects"

import type { WOFFeature } from "./placetypes/admin.ts"

/**
 * The GitHub organization holding the country data repositories.
 */
export const WOF_DATA_OWNER = "whosonfirst-data"

/**
 * The repository name for a country's data of one theme — `whosonfirst-data-admin-tr`.
 *
 * Four call sites used to build this string themselves, each with its own `toLowerCase()`, which is how a country code
 * arriving uppercase became a directory that silently does not exist.
 */
export function wofRepoName(theme: "admin" | "postalcode" | "venue", country: string): string {
	return `${WOF_DATA_OWNER}-${theme}-${country.toLowerCase()}`
}

/**
 * Find a cloned repository under a repositories root, in either layout.
 *
 * Two are in use and both are legitimate. `gazetteer inspect sync` writes `<root>/<owner>/<name>`, which is what the
 * admin ingest's depth-agnostic GeoJSON glob reads. The shipped postcode shards were built from repositories cloned by
 * hand as `<root>/<name>`. A reader that knows one layout reports a repository that is present as MISSING, and every
 * reader here treats missing as "no evidence" and continues — so the wrong layout is silent, not loud.
 *
 * Synchronous to match {@link readWOFFeature}: these readers run inside sync loops over database rows.
 */
export function resolveWOFRepo(reposRoot: string, name: string, owner = WOF_DATA_OWNER): string | null {
	for (const candidate of [resolvePath(reposRoot, owner, name), resolvePath(reposRoot, name)]) {
		try {
			if (statSync(candidate).isDirectory()) return candidate.toString()
		} catch {
			// Absent, or unreadable — try the other layout, then answer null.
		}
	}

	return null
}

/**
 * The `data` directory of a country's repository, or `null` when the repository is not cloned.
 *
 * The pairing every reader needs: {@link readWOFFeature} takes roots that already point INTO `data`.
 */
export function resolveWOFDataDir(
	reposRoot: string,
	theme: "admin" | "postalcode" | "venue",
	country: string
): string | null {
	const repo = resolveWOFRepo(reposRoot, wofRepoName(theme, country))

	return repo && resolvePath(repo, "data").toString()
}

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
