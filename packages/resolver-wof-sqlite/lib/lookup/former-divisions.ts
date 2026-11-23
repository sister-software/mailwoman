// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file The former administrative divisions table: each division that no longer exists, with
 *   the current places its containment evidence ties it to.
 *
 *   `mailwoman gazetteer` tooling builds the table from GeoNames' historical divisions
 *   (feature codes `ADM1H` through `ADM5H` and `PCLH`) and from Who's On First's ceased admin records,
 *   for every country. The resolver reads it behind the `formerDivisions` switch, and the
 *   `former-divisions` corpus recipe reads it to place a former division in rendered addresses.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import type { FormerDivisionLookup, FormerDivisionMatch } from "@mailwoman/core/resolver"
import type { PathBuilder, PathBuilderLike } from "path-ts"

import { normalizeLocalityForKey } from "#labels/street/normalize"

/**
 * The table's default location, `$MAILWOMAN_DATA_ROOT/gazetteer/former-divisions-v1.json`.
 */
export function formerDivisionsTablePath(): PathBuilder {
	return dataRootPath("gazetteer", "former-divisions-v1.json")
}

/**
 * Reads the table at `path`.
 *
 * @throws When the file is absent or isn't format 1, with the path in the message,
 * because a caller that asked for former divisions mustn't run as though none existed.
 */
export async function readFormerDivisionsTable(
	path: PathBuilderLike = formerDivisionsTablePath()
): Promise<FormerDivisionsTable> {
	if (!(await pathExists(path))) {
		throw new Error(
			`former divisions table not found at ${path}; build it with \`node packages/gazetteer/tools/former-divisions.run.ts\``
		)
	}

	const table = await readLocalJSONFile<FormerDivisionsTable>(path)

	if (table.format !== 1 || !Array.isArray(table.divisions)) {
		throw new Error(`${path} is not a format-1 former divisions table`)
	}

	return table
}

/**
 * The containment evidence a link rests on.
 */
export const FormerDivisionEvidence = {
	/**
	 * A GeoNames `hierarchy.txt` row whose parent is the historical division.
	 */
	GeonamesHierarchy: "geonames_hierarchy",
	/**
	 * Current GeoNames rows that still hold the historical division's retired admin code.
	 */
	GeonamesAdminCodes: "geonames_admin_codes",
	/**
	 * A ceased WOF record's `wof:superseded_by`.
	 */
	WOFSupersession: "wof_supersession",
} as const

export type FormerDivisionEvidence = (typeof FormerDivisionEvidence)[keyof typeof FormerDivisionEvidence]

/**
 * The current places one kind of evidence ties a former division to.
 */
export interface FormerDivisionLink {
	evidence: FormerDivisionEvidence
	/**
	 * WOF ids of the current places, sorted.
	 */
	wofIDs: number[]
}

/**
 * One former division.
 */
export interface FormerDivisionRecord {
	/**
	 * Upper-case ISO 3166-1 alpha-2 code.
	 */
	country: string
	name: string
	/**
	 * Every surface name the division is matched by, `name` first.
	 */
	names: string[]
	/**
	 * The GeoNames feature code (`ADM2H`) or, for a division only WOF records, its placetype (`county`).
	 */
	kind: string
	/**
	 * The `ComponentTag` the division takes in an address: `subregion` at county level,
	 * else the matching level.
	 */
	tag: "country" | "region" | "subregion" | "locality"
	geonamesID: number | null
	wofID: number | null
	latitude: number | null
	longitude: number | null
	/**
	 * At least one link.
	 *
	 * The builder leaves a division without a link out of the table.
	 */
	links: FormerDivisionLink[]
}

/**
 * The table's file.
 */
export interface FormerDivisionsTable {
	format: 1
	builtAt: string
	/**
	 * Each input's path and digest, so a reader can tell which inputs built the table.
	 */
	inputs: Record<string, string>
	divisions: FormerDivisionRecord[]
}

/**
 * The key a former division's name is matched under, the candidate table's locality fold.
 */
export function formerDivisionNameKey(name: string): string {
	return normalizeLocalityForKey(name)
}

/**
 * Reads the table at `path` and indexes it, throwing as {@link readFormerDivisionsTable} does.
 */
export async function readFormerDivisionLookup(
	path: PathBuilderLike = formerDivisionsTablePath()
): Promise<FormerDivisionLookup> {
	return createFormerDivisionLookup(await readFormerDivisionsTable(path))
}

/**
 * Indexes a table's divisions by name key for {@link FormerDivisionLookup.divisionsNamed}.
 */
export function createFormerDivisionLookup(table: Pick<FormerDivisionsTable, "divisions">): FormerDivisionLookup {
	const byKey = new Map<string, FormerDivisionMatch[]>()

	for (const division of table.divisions) {
		const match: FormerDivisionMatch = {
			name: division.name,
			country: division.country,
			kind: division.kind,
			tag: division.tag,
			geonamesID: division.geonamesID,
			wofID: division.wofID,
			linkedIDs: new Set(division.links.flatMap((link) => link.wofIDs)),
			evidence: division.links.map((link) => link.evidence),
		}

		for (const key of new Set(division.names.map(formerDivisionNameKey).filter((folded) => folded.length > 0))) {
			let matches = byKey.get(key)

			if (!matches) {
				byKey.set(key, (matches = []))
			}

			matches.push(match)
		}
	}

	return {
		divisionsNamed(value, country) {
			const matches = byKey.get(formerDivisionNameKey(value)) ?? []

			return country ? matches.filter((match) => match.country === country) : matches
		},
	}
}
