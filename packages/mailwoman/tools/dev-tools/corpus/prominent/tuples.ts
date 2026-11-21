// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `prominent-places` recipe's input: for each required prominent place,
 *   the rows to write in each shape so a corpus built from the scanned base plus the
 *   recipe meets the `prominent_place_coverage` receipt on rows.
 *
 *   The counts are stratified by country, placetype band and shape:
 *
 *   - **Presence.** A required place with no train row in a required shape gets one.
 *   - **Demand share.** A cell whose decile 1 falls short of its target gets
 *     {@linkcode decileOneDeficit} rows, divided by {@linkcode apportionUnderCap} among
 *     every decile-1 place of the cell that the receipt can count, required or not.
 *
 *   Two caps follow from the rule, and neither is a fitted number:
 *
 *   - **Per country.** A country's demand rows are exactly the sum of its own cells' deficits,
 *     each measured against that country's own base rows, so no country writes rows another
 *     country's cell needs. {@linkcode writeProminentTuples} throws when the sum differs.
 *   - **Per place.** No place takes more of a cell's deficit than `ceil(deficit / places)`,
 *     the smallest equal count that meets the cell.
 *     The receipt counts decile 1's rows as one total, so the deficit is spread across
 *     all of decile 1 rather than piled onto its largest place.
 *
 *   A decile-1 place whose score rests on a GeoNames population that failed its
 *   checks gets no demand rows, as it can't be required either.
 *
 *   A sub-locality written bare or with its region or country gets no rows, as `prominentPlaceTag` states.
 *
 *   The scan must be of the base corpus the recipe's output joins, before the recipe's rows exist.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { type DuckDBLimits, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import type { PlaceBand, ProminentPlaceTuple, QueryShape } from "@mailwoman/corpus/recipes/prominent/places"
import { createDisplayCountryName } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/render"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"

import {
	createProminentCoverageTables,
	queryRows,
	readDemandCells,
	DEMAND_SHARE_FRACTION,
	decileOneDeficit,
	readProminentPlacesRecord,
} from "#tools/training/audits/prominent/coverage"

/**
 * Divides `total` among `weights.length` places so no part exceeds `ceil(total / places)`,
 * the smallest cap whose parts can sum to `total`.
 *
 * Every place takes `floor(total / places)`, and the remainder goes one row each
 * to the heaviest weights, earlier index first among equals.
 * The parts sum to `total`.
 */
export function apportionUnderCap(total: number, weights: readonly number[]): number[] {
	if (!weights.length) return []

	const base = Math.floor(total / weights.length)
	const parts = weights.map(() => base)

	const order = weights
		.map((weight, index) => ({ index, weight }))
		.toSorted((a, b) => b.weight - a.weight || a.index - b.index)

	for (const { index } of order.slice(0, total - base * weights.length)) {
		parts[index]!++
	}

	return parts
}

/**
 * The places the recipe may write, as SQL over `ranked`: every required place, and every decile-1
 * place whose score rests on no GeoNames population or on a GeoNames match that passed its checks.
 */
const WRITABLE_PLACE_SQL = "(required OR (decile = 1 AND (score_source <> 'geonames' OR geonames_check = 'verified')))"

/**
 * Each country's primary WOF name in the candidate table, keyed by its ISO code.
 */
async function readCandidateCountryNames(candidateDB: string): Promise<Map<string, string>> {
	using candidates = await openBuiltClient<CandidateDatabase>(candidateDB)

	// WOF records a territory such as American Samoa or Bonaire as a `dependency` rather than a `country`.
	const placetypes = (
		await candidates
			.selectFrom("placetype_codes")
			.select("id")
			.where("placetype", "in", ["country", "dependency"])
			.execute()
	).map((row) => row.id)

	if (!placetypes.length) throw new Error(`${candidateDB} lists neither the country nor the dependency placetype`)

	const codes = new Map(
		(await candidates.selectFrom("country_codes").select(["id", "code"]).execute()).map((row) => [row.id, row.code])
	)

	const names = new Map<string, string>()

	for await (const row of candidates
		.selectFrom("candidate")
		.select(["country_id", "name"])
		.where("placetype_id", "in", placetypes)
		.where("is_primary", "=", 1)
		.stream()) {
		const code = codes.get(row.country_id)

		if (code && row.name && !names.has(code)) {
			names.set(code, row.name)
		}
	}

	return names
}

interface PlaceShapeRow {
	spr_id: number
	country: string
	band: ProminentPlaceTuple["band"]
	query_shape: QueryShape
	rows: number
	decile: number | null
	population_used: number | null
	required: boolean
}

interface PlaceRow {
	spr_id: number
	country: string
	band: ProminentPlaceTuple["band"]
	name: string
	parent_locality: string | null
	region: string | null
	region_abbrs: string[]
}

export interface ProminentTuplesSummary {
	places: number
	rows: number
	rows_by_band_shape: Record<string, number>
	presence_rows: number
	demand_rows: number
	/**
	 * Each country's presence and demand rows, largest first.
	 */
	rows_by_country: Array<{ country: string; presence_rows: number; demand_rows: number }>
	/**
	 * The largest share of one cell's deficit any place takes.
	 */
	largest_place_part: number
	/**
	 * Cells short of their target with no decile-1 place the recipe can write.
	 */
	unmet_cells: Array<{ country: string; band: string; query_shape: string; deficit: number }>
}

/**
 * Writes `prominent-tuples.jsonl` into `out` from `places.parquet` and the base
 * corpus's `short-admin-rows.parquet` there.
 */
export async function writeProminentTuples(options: {
	out: string
	limits?: DuckDBLimits
}): Promise<ProminentTuplesSummary> {
	const placesPath = `${options.out}/places.parquet`

	const record = await readProminentPlacesRecord(placesPath)
	const countryNames = await readCandidateCountryNames(record.candidate_db)
	// A territory WOF records under no country or dependency (BQ, CC, IO) takes its English region name.
	const displayName = createDisplayCountryName()

	using db = await openDuckDB(options.limits)

	await createProminentCoverageTables(db, placesPath, `${options.out}/short-admin-rows.parquet`)

	const placeShapes = await queryRows(
		db,
		"SELECT s.spr_id, s.country, s.band, s.query_shape, s.rows, r.decile, r.population_used, r.required " +
			`FROM place_shapes s JOIN ranked r USING (spr_id) WHERE ${WRITABLE_PLACE_SQL} ` +
			"ORDER BY s.country, s.band, s.query_shape, s.spr_id",
		(row): PlaceShapeRow => ({
			spr_id: row.number("spr_id"),
			country: row.text("country"),
			band: row.text("band") as PlaceBand,
			query_shape: row.text("query_shape") as QueryShape,
			rows: row.number("rows"),
			decile: row.optionalNumber("decile"),
			population_used: row.optionalNumber("population_used"),
			required: row.text("required") === "true",
		})
	)

	const cellKey = (row: { country: string; band: string; query_shape: string }) =>
		`${row.country}\u0000${row.band}\u0000${row.query_shape}`

	const placeShapesByCell = Map.groupBy(placeShapes, cellKey)
	const cells = await readDemandCells(db)

	const places = new Map(
		(
			await queryRows(
				db,
				"SELECT spr_id, country, band, name, parent_locality, region, region_abbrs FROM ranked " +
					`WHERE ${WRITABLE_PLACE_SQL}`,
				(row): PlaceRow => ({
					spr_id: row.number("spr_id"),
					country: row.text("country"),
					band: row.text("band") as PlaceBand,
					name: row.text("name"),
					parent_locality: row.optionalText("parent_locality"),
					region: row.optionalText("region"),
					region_abbrs: row.textList("region_abbrs"),
				})
			)
		).map((place) => [place.spr_id, place])
	)

	const counts = new Map<number, Partial<Record<QueryShape, number>>>()
	let presenceRows = 0
	let demandRows = 0

	const add = (id: number, shape: QueryShape, rows: number) => {
		const entry = counts.get(id) ?? {}

		entry[shape] = (entry[shape] ?? 0) + rows
		counts.set(id, entry)
	}

	const byCountry = new Map<string, { presence_rows: number; demand_rows: number; deficit: number }>()

	const tally = (country: string) => {
		const entry = byCountry.get(country) ?? { presence_rows: 0, demand_rows: 0, deficit: 0 }

		byCountry.set(country, entry)

		return entry
	}

	for (const row of placeShapes) {
		if (row.required && row.rows === 0) {
			add(row.spr_id, row.query_shape, 1)

			presenceRows++

			tally(row.country).presence_rows++
		}
	}

	let largestPart = 0
	const unmet: ProminentTuplesSummary["unmet_cells"] = []

	for (const cell of cells) {
		if (cell.decile1_population_share == null) continue

		const writable = placeShapesByCell.get(cellKey(cell)) ?? []
		const members = writable.filter((row) => row.decile === 1)

		// The presence rows written above count toward the cell, and a decile-1 place's toward decile 1.
		const presence = writable.filter((row) => row.required && row.rows === 0).length
		const decile1Presence = members.filter((row) => row.required && row.rows === 0).length

		const deficit = decileOneDeficit(
			cell.rows + presence,
			cell.decile1_rows + decile1Presence,
			DEMAND_SHARE_FRACTION * cell.decile1_population_share
		)

		if (!deficit) continue

		if (!members.length) {
			unmet.push({ country: cell.country, band: cell.band, query_shape: cell.query_shape, deficit })

			continue
		}

		tally(cell.country).deficit += deficit

		const parts = apportionUnderCap(
			deficit,
			members.map((row) => row.population_used ?? 0)
		)

		for (const [index, row] of members.entries()) {
			const part = parts[index] ?? 0

			if (part) {
				add(row.spr_id, row.query_shape, part)
			}

			largestPart = Math.max(largestPart, part)
			demandRows += part
			tally(row.country).demand_rows += part
		}
	}

	for (const [country, entry] of byCountry) {
		if (entry.demand_rows !== entry.deficit) {
			throw new Error(`${country} takes ${entry.demand_rows} demand rows against its own deficit of ${entry.deficit}`)
		}
	}

	const lines: string[] = []
	const byShape: Record<string, number> = {}

	for (const [id, rows] of [...counts].toSorted(([a], [b]) => a - b)) {
		const place = places.get(id)!

		const tuple: ProminentPlaceTuple = {
			...place,
			region_abbrs: place.region_abbrs,
			country_name: countryNames.get(place.country) ?? displayName(place.country, "en") ?? null,
			rows,
		}

		lines.push(stringifyJSON(tuple))

		for (const [shape, n] of Object.entries(rows)) {
			byShape[`${place.band}:${shape}`] = (byShape[`${place.band}:${shape}`] ?? 0) + n
		}
	}

	await writeLocalTextFile(lines.join("\n") + (lines.length ? "\n" : ""), `${options.out}/prominent-tuples.jsonl`)

	return {
		places: lines.length,
		rows: presenceRows + demandRows,
		rows_by_band_shape: byShape,
		presence_rows: presenceRows,
		demand_rows: demandRows,
		rows_by_country: [...byCountry]
			.map(([country, entry]) => ({
				country,
				presence_rows: entry.presence_rows,
				demand_rows: entry.demand_rows,
			}))
			.toSorted((a, b) => b.presence_rows + b.demand_rows - (a.presence_rows + a.demand_rows)),
		largest_place_part: largestPart,
		unmet_cells: unmet,
	}
}
