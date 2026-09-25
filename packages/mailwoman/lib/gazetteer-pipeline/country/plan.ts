/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Plans the recipe edits and repository clones needed to move a country between admin sources.
 *
 *   The plan reads each country's current sources from the built gazetteer. The source lists in
 *   `defaults.ts` can disagree with the build, because the WOF leg ingests whatever repositories are
 *   present.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { getRow } from "@mailwoman/core/utils"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { AdminSource } from "#gazetteer-pipeline/country/sources"

/**
 * The start of each fold's synthetic ID range, copied from the modules that assign them.
 *
 * `country-sources.test.ts` checks these copies against the exported constants.
 */
const OVERTURE_BAND_START = 8_000_000_000_000
const GEONAMES_BAND_START = 9_000_000_000_000

/**
 * The number of rows each source contributes to a country in the built gazetteer.
 */
export interface SourceCensus {
	country: string
	wof: number
	overture: number
	geonames: number
}

/**
 * Reads the per-source row counts for one country from an admin gazetteer.
 *
 * The source is inferred from the ID range, because `spr` does not record which fold wrote a row.
 */
export function censusForCountry(adminDBPath: string, country: string): SourceCensus {
	using db = new DatabaseClient<WOFDatabase>(adminDBPath, { readOnly: true })

	const row = getRow<{ wof: number | null; overture: number | null; geonames: number | null }>(
		db.prepare(
			`SELECT
				SUM(CASE WHEN id < ? THEN 1 ELSE 0 END) AS wof,
				SUM(CASE WHEN id >= ? AND id < ? THEN 1 ELSE 0 END) AS overture,
				SUM(CASE WHEN id >= ? THEN 1 ELSE 0 END) AS geonames
			FROM spr WHERE country = ?`
		),
		OVERTURE_BAND_START,
		OVERTURE_BAND_START,
		GEONAMES_BAND_START,
		GEONAMES_BAND_START,
		country.toUpperCase()
	)

	return {
		country: country.toUpperCase(),
		wof: Number(row?.wof ?? 0),
		overture: Number(row?.overture ?? 0),
		geonames: Number(row?.geonames ?? 0),
	}
}

/**
 * Returns every source that contributes rows to a country, largest first.
 *
 * @returns An empty array when the country has no rows.
 */
export function servingSources(census: SourceCensus): AdminSource[] {
	return (
		[
			[AdminSource.WOF, census.wof],
			[AdminSource.Overture, census.overture],
			[AdminSource.GeoNames, census.geonames],
		] as const
	)
		.filter(([, n]) => n > 0)
		.toSorted((a, b) => b[1] - a[1])
		.map(([source]) => source)
}

/**
 * The approximate ratio of a cloned WOF repository's disk size to the packed size GitHub reports.
 *
 * WOF repositories unpack to many small GeoJSON files, so operators should see the checkout size.
 */
export const CHECKOUT_SIZE_RATIO = 7

/**
 * One edit to a source list in `defaults.ts` that a move requires.
 *
 * The plan prints edits for a person to apply, because the list entries carry
 * explanatory prose that an automatic rewrite would lose.
 */
export interface RecipeEdit {
	list: string
	action: "add" | "remove"
	country: string
	why: string
}

/**
 * The plan for moving one country to a target source.
 */
export interface CountryPlan {
	country: string
	census: SourceCensus
	current: AdminSource[]
	target: AdminSource
	edits: RecipeEdit[]
	/**
	 * The repositories the move would clone, with estimated checkout sizes.
	 */
	repos: Array<{ name: string; packedKB?: number; checkoutKB?: number }>
	/**
	 * The reasons the move cannot proceed.
	 * The array is empty when it can.
	 */
	blockers: string[]
}

/**
 * Computes the plan for moving `country` to `target`.
 *
 * The function is pure, so it runs without a gazetteer, network access, or a GitHub token.
 */
export function planCountryMove(options: {
	country: string
	target: AdminSource
	census: SourceCensus
	repos: Array<{ name: string; packedKB?: number; exists: boolean }>
}): CountryPlan {
	const country = options.country.toUpperCase()
	const current = servingSources(options.census)
	const edits: RecipeEdit[] = []
	const blockers: string[] = []

	if (options.target === AdminSource.WOF) {
		const missing = options.repos.filter((r) => !r.exists)

		if (missing.length === options.repos.length) {
			blockers.push(
				`No WOF repository exists for ${country} (looked for ${options.repos.map((r) => r.name).join(", ")}). ` +
					"The country has no WOF path; Overture or GeoNames is the only route."
			)
		}

		// A country that already has WOF rows is already on the list.
		if (!current.includes(AdminSource.WOF)) {
			edits.push({
				list: "DEFAULT_WOF_PRIORITY_COUNTRIES",
				action: "add",
				country,
				why: "the WOF leg is presence-driven, but the list is the declaration a reviewer reads",
			})
		}
	}

	// Every other current source must be removed.
	// Otherwise both sources fold into one database, and `verifyAdmin` does not catch it
	// because duplicate rows only raise the counts it checks.
	for (const source of current) {
		if (source === options.target) continue

		const list =
			source === AdminSource.Overture
				? "DEFAULT_OVERTURE_COUNTRIES"
				: source === AdminSource.GeoNames
					? "DEFAULT_GEONAMES_COUNTRIES"
					: "DEFAULT_WOF_PRIORITY_COUNTRIES"

		edits.push({
			list,
			action: "remove",
			country,
			why: `${country} currently has ${
				source === AdminSource.WOF
					? options.census.wof
					: source === AdminSource.Overture
						? options.census.overture
						: options.census.geonames
			} rows from ${source}; leaving it listed folds both sources into one database`,
		})
	}

	if (!current.length) {
		blockers.push(
			`${country} has no rows in the admin gazetteer at all, so there is nothing to move FROM. Adding it is a ` +
				"coverage change rather than a source change — and `verify-baseline.ts` needs a requiredNodes entry."
		)
	}

	return {
		country,
		census: options.census,
		current,
		target: options.target,
		edits,
		repos: options.repos.map((r) => ({
			name: r.name,
			...(r.packedKB === undefined ? {} : { packedKB: r.packedKB, checkoutKB: r.packedKB * CHECKOUT_SIZE_RATIO }),
		})),
		blockers,
	}
}

/**
 * Returns whether an admin gazetteer exists at `path`.
 */
export async function adminDBAvailable(path: string): Promise<boolean> {
	return await pathExists(path)
}
