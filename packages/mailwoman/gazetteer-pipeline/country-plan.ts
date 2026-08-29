/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   What moving a country between admin sources would involve — computed, not remembered.
 *
 *   Every failure in the thread that produced this was a COORDINATION failure rather than a hard one. A
 *   repository name landed in a destination slot and 65 GB arrived. A filter went missing. The recipe has
 *   to be edited in the same change as the clone, and nothing checked it. Each step is individually
 *   simple; what is hard is that they must agree, and the agreement was held by prose.
 *
 *   So this reads the CURRENT state from the artifact rather than from the lists. The lists are a
 *   declaration and the WOF leg is presence-driven, so the artifact is the only place the two are already
 *   reconciled — and reading the declaration to decide what to change is how #1015 happened.
 */

import { getRow } from "@mailwoman/core/utils"
import { existsSync } from "@mailwoman/platform/fs"
import type { WOFDatabase } from "@mailwoman/resolver-wof-sqlite/schema"
import { DatabaseClient } from "@mailwoman/sqlite/client"

import { AdminSource } from "./country-sources.ts"

/**
 * Synthetic-id band boundaries, duplicated from the folds that mint them ONLY as SQL literals — a query cannot import a
 * constant. `country-sources.test.ts` pins them against the exporting modules so the two cannot drift silently.
 */
const OVERTURE_BAND_START = 8_000_000_000_000
const GEONAMES_BAND_START = 9_000_000_000_000

/**
 * How many rows each source contributes to a country, in the built artifact.
 */
export interface SourceCensus {
	country: string
	wof: number
	overture: number
	geonames: number
}

/**
 * Read the per-source row counts for one country out of an admin gazetteer.
 *
 * The band arithmetic IS the measurement: nothing in `spr` records which fold wrote a row, so the id range is the only
 * evidence — which is also how the #1015 recipe had to be reconstructed after the manifest lagged.
 */
export function censusForCountry(adminDBPath: string, country: string): SourceCensus {
	const db = new DatabaseClient<WOFDatabase>(adminDBPath, { readOnly: true })

	try {
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
	} finally {
		db.destroy()
	}
}

/**
 * The source serving a country today, or `undefined` when it has no rows at all.
 *
 * Returns the LARGEST contributor when several are present, because that is the one a move is actually moving away from
 * — and names the rest, so a two-source country reads as two-source rather than as its winner.
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
 * GitHub reports PACKED size; a WOF repo unpacks to millions of small GeoJSON files.
 *
 * Measured on a `--countries tr` sync: three repositories reported as 83.4 MB occupied 633 MB once cloned. The ratio is
 * stated here rather than at each call site because the number a caller is about to show an operator is the checkout
 * cost, and quoting the packed figure is how 65 GB arrived unannounced.
 */
export const CHECKOUT_SIZE_RATIO = 7

/**
 * One edit a move requires, as a reviewable statement rather than an applied patch.
 *
 * `defaults.ts` is reviewed like code and its entries carry measurements — the `IN` entry is six lines recording
 * 189,026 sub-locality nodes at 98.6% conversion. A tool that rewrote that file silently would drop the prose at the
 * one moment a reader most needs it, so the plan PRINTS the edit and leaves the commit to a person.
 */
export interface RecipeEdit {
	list: string
	action: "add" | "remove"
	country: string
	why: string
}

export interface CountryPlan {
	country: string
	census: SourceCensus
	current: AdminSource[]
	target: AdminSource
	edits: RecipeEdit[]
	/**
	 * Repositories the move would clone, with the checkout cost already multiplied out.
	 */
	repos: Array<{ name: string; packedKB?: number; checkoutKB?: number }>
	/**
	 * Reasons the move cannot proceed. Empty when it can.
	 */
	blockers: string[]
}

/**
 * Compute the plan for moving `country` to `target`.
 *
 * Pure: every input is passed in, so the plan is testable without a gazetteer, a network, or a GitHub token — which is
 * also what lets `--plan` run in CI.
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

		// Only when the target is not ALREADY serving. A country whose rows already come from WOF needs no
		// addition, and printing one would have a reader edit a list the country is on — the plan would then
		// be describing work that is done, which is the failure mode a plan is supposed to remove.
		if (!current.includes(AdminSource.WOF)) {
			edits.push({
				list: "DEFAULT_WOF_PRIORITY_COUNTRIES",
				action: "add",
				country,
				why: "the WOF leg is presence-driven, but the list is the declaration a reviewer reads",
			})
		}
	}

	// The half that nothing enforced. A country served by two sources folds both into one database, and
	// `verifyAdmin` tests FLOORS — rows >= minRows, countries >= minCountries — so duplication moves every gate
	// number in the passing direction and the build ships.
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
 * Whether an admin gazetteer is readable at `path`, so a caller can degrade rather than throw.
 */
export function adminDBAvailable(path: string): boolean {
	return existsSync(path)
}
