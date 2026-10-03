/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Repair the truncated ancestry left by the `parent_id` closure. Must run after `populateAncestors` and before the build freezes.
 */

import { readWOFFeature } from "@mailwoman/core/resources/whosonfirst"
import type { DatabaseClient } from "@mailwoman/sqlite/client"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { WOFDatabase } from "#schema"

const TOP_PLACETYPES = new Set(["country", "continent", "empire", "ocean", "marinearea", "planet"])

export interface AncestryBackfillResult {
	placesFixed: number
	rowsAdded: number
	/**
	 * Candidates whose source geojson was not found (non-WOF backfilled places or absent repos),
	 * skipped rather than treated as an error.
	 */
	noGeojson: number
}

/**
 * Discover the `data` directories under a WOF repos root that hold attached geojson,
 * accepting both the nested lab layout and a flat layout at most two directory levels deep.
 */
export async function discoverAdminDataRoots(reposRoot: PathBuilderLike): Promise<PathBuilder[]> {
	const roots: PathBuilder[] = []

	const visit = async (dir: PathBuilder, depth: number): Promise<void> => {
		if (depth > 2) return

		let names: string[]

		try {
			names = (await Globerator.from("*", { cwd: dir, withFileTypes: true, onlyFiles: false }).toArray())
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
		} catch {
			return
		}

		for (const name of names) {
			const child = dir(name)

			if (name === "data") {
				roots.push(child)
			} else if (name.startsWith("whosonfirst-data")) {
				await visit(child, depth + 1)
			}
		}
	}

	await visit(PathBuilder.from(reposRoot), 0)

	return roots
}

// The `aid === id` check filters out a place's own `locality_id`.
// For a neighborhood, that id identifies a real ancestor.
function placetypeFromKey(key: string): string | null {
	if (!key.endsWith("_id")) return null

	return key.slice(0, -3)
}

/**
 * Insert missing ancestor rows for places whose ancestry chain ended before reaching a country.
 *
 * The function reads `wof:hierarchy` and runs in one transaction under the caller's connection.
 * `opts.maxID` bounds the scan to avoid probing synthetic-id Overture and GeoNames rows.
 */
export async function backfillAncestorsFromHierarchy(
	db: DatabaseClient<WOFDatabase>,
	geojsonRoots: readonly PathBuilderLike[],
	opts: { maxID?: number } = {}
): Promise<AncestryBackfillResult> {
	const maxID = opts.maxID ?? Number.MAX_SAFE_INTEGER

	// The id bound is stated first so SQLite prunes by the PK index before the not-exists runs.
	const candidateBase = db
		.selectFrom("spr")
		.where("id", "<", maxID)
		.where((eb) =>
			eb.not(
				eb.exists(
					eb
						.selectFrom("ancestors as a")
						.select("a.id")
						.whereRef("a.id", "=", "spr.id")
						.where("a.ancestor_placetype", "=", "country")
				)
			)
		)

	const candidates = await candidateBase.select(["id", "placetype"]).execute()

	// Keep the candidate set as a subquery instead of materializing an `IN` list.
	// node:sqlite limits bound variables to 32,766.
	const alreadyPresent = new Map<number, Set<number>>()

	for (const row of await db
		.selectFrom("ancestors")
		.select(["id", "ancestor_id"])
		.where("id", "in", candidateBase.select("spr.id"))
		.execute()) {
		let set = alreadyPresent.get(row.id)

		if (!set) {
			set = new Set()
			alreadyPresent.set(row.id, set)
		}

		set.add(Number(row.ancestor_id))
	}

	const insert = db.prepare(
		"INSERT INTO ancestors (id, ancestor_id, ancestor_placetype, lastmodified) VALUES (?, ?, ?, 0)"
	)

	let placesFixed = 0
	let rowsAdded = 0
	let noGeojson = 0
	db.exec("BEGIN")

	for (const { id, placetype } of candidates) {
		if (placetype && TOP_PLACETYPES.has(placetype)) continue
		const gj = await readWOFFeature(id, geojsonRoots)
		const hierarchy = gj?.properties?.["wof:hierarchy"]

		if (!hierarchy || !hierarchy.length) {
			if (!gj) {
				noGeojson++
			}

			continue
		}

		const seen = new Map<number, string>()

		for (const branch of hierarchy) {
			for (const [key, val] of Object.entries(branch)) {
				const pt = placetypeFromKey(key)

				if (!pt) continue
				const aid = Number(val)

				if (!Number.isFinite(aid) || aid <= 0 || aid === id) continue

				if (!seen.has(aid)) {
					seen.set(aid, pt)
				}
			}
		}

		let present = alreadyPresent.get(id)

		if (!present) {
			present = new Set()
			alreadyPresent.set(id, present)
		}

		let added = 0

		for (const [aid, pt] of seen) {
			if (present.has(aid)) continue

			insert.run(id, aid, pt)
			present.add(aid)

			added++
		}

		if (added > 0) {
			placesFixed++
			rowsAdded += added
		}
	}

	db.exec("COMMIT")

	return { placesFixed, rowsAdded, noGeojson }
}
