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
 *     {@linkcode decileOneDeficit} rows, divided among the cell's required decile-1 places in
 *     proportion to their population by largest remainder, or evenly where none records one.
 *     The cap is the receipt's own target: no cell is written past the share that meets it.
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
 * Divides `total` among `weights` in proportion, by largest remainder, so the parts sum to `total`.
 * All-zero weights divide it evenly.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
	if (!weights.length) return []

	const sum = weights.reduce((a, b) => a + b, 0)
	const shares = weights.map((weight) => (sum > 0 ? (total * weight) / sum : total / weights.length))
	const parts = shares.map(Math.floor)
	let left = total - parts.reduce((a, b) => a + b, 0)

	const order = shares
		.map((share, index) => ({ index, remainder: share - Math.floor(share) }))
		.toSorted((a, b) => b.remainder - a.remainder || a.index - b.index)

	for (const { index } of order) {
		if (left <= 0) break

		parts[index]!++

		left--
	}

	return parts
}

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
		"SELECT s.spr_id, s.country, s.band, s.query_shape, s.rows, r.decile, r.population_used FROM place_shapes s " +
			"JOIN ranked r USING (spr_id) WHERE r.required ORDER BY s.country, s.band, s.query_shape, s.spr_id",
		(row): PlaceShapeRow => ({
			spr_id: row.number("spr_id"),
			country: row.text("country"),
			band: row.text("band") as PlaceBand,
			query_shape: row.text("query_shape") as QueryShape,
			rows: row.number("rows"),
			decile: row.optionalNumber("decile"),
			population_used: row.optionalNumber("population_used"),
		})
	)

	const cells = await readDemandCells(db)

	const places = new Map(
		(
			await queryRows(
				db,
				"SELECT spr_id, country, band, name, parent_locality, region, region_abbrs FROM ranked WHERE required",
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

	for (const row of placeShapes) {
		if (row.rows === 0) {
			add(row.spr_id, row.query_shape, 1)

			presenceRows++
		}
	}

	for (const cell of cells) {
		if (cell.decile1_population_share == null) continue

		const required = placeShapes.filter(
			(row) => row.country === cell.country && row.band === cell.band && row.query_shape === cell.query_shape
		)

		const members = required.filter((row) => row.decile === 1)

		if (!members.length) continue

		// The presence rows written above count toward the cell, and a decile-1 place's toward decile 1.
		const presence = required.filter((row) => row.rows === 0).length
		const decile1Presence = members.filter((row) => row.rows === 0).length

		const deficit = decileOneDeficit(
			cell.rows + presence,
			cell.decile1_rows + decile1Presence,
			DEMAND_SHARE_FRACTION * cell.decile1_population_share
		)

		const parts = apportion(
			deficit,
			members.map((row) => row.population_used ?? 0)
		)

		for (const [index, row] of members.entries()) {
			const part = parts[index] ?? 0

			if (part) {
				add(row.spr_id, row.query_shape, part)
			}

			demandRows += part
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
	}
}
