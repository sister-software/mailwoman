// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The `prominent-places` recipe's input: for each required prominent place,
 *   the rows to write in each shape so a corpus built from the scanned base plus the recipe
 *   meets the `prominent_place_coverage` receipt under the training config it runs for.
 *
 *   The receipt measures the demand share in expected epoch draws, so the counts are set in draws too.
 *   The config gives the recipe's source a fixed share of the epoch, its draw budget.
 *
 *   The sampler spreads that budget over the recipe's admitted rows alike.
 *   A recipe row of a country admitted with chance `a` therefore takes `a × budget / A`
 *   draws, where `A` is the recipe's admitted rows, and {@linkcode solveRecipeRows}
 *   finds the row counts whose own `A` gives each cell its deficit.
 *
 *   The counts are stratified by country, placetype band and shape:
 *
 *   - **Presence.** A required place with no drawable train row in a required shape gets one.
 *   - **Demand share.** A cell whose decile 1 falls short of its target in draws gets the rows
 *     whose draws close its {@linkcode decileOneDeficit}, divided by {@linkcode apportionUnderCap}
 *     among every decile-1 place of the cell that the receipt can count, required or not.
 *
 *   Two caps follow from the rule, and neither is a fitted number:
 *
 *   - **Per country.** A country's demand rows are exactly the sum of its own cells' rows,
 *     each set against that country's own base draws, so no country writes rows another
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
 *   Each tuple copies the places table's `postal_pair`, the reading the recipe
 *   writes a sub-locality's pair in.
 *
 *   The scan must be of the base corpus the recipe's output joins, before the recipe's rows exist.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { type DuckDBLimits, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import {
	PROMINENT_PLACES_SOURCE,
	type PlaceBand,
	type ProminentPlaceTuple,
	type QueryShape,
} from "@mailwoman/corpus/recipes/prominent/places"
import { createDisplayCountryName } from "@mailwoman/corpus/tools/fetch/wikidata/vital-places/render"
import type { CandidateDatabase } from "@mailwoman/resolver-wof-sqlite/candidate/schema"
import { openBuiltClient } from "@mailwoman/sqlite/sealed"

import {
	createProminentCoverageTables,
	epochRates,
	type EpochMeasure,
	queryRows,
	readDemandCells,
	DEMAND_SHARE_FRACTION,
	decileOneDeficit,
	readProminentPlacesRecord,
	writablePlaceSQL,
} from "#tools/training/audits/prominent/coverage"

/**
 * One demand cell as {@linkcode solveRecipeRows} reads it: its base draws, decile 1's base draws,
 * its target share, the presence rows the recipe writes into it, and the country's admission chance.
 */
export interface DemandCellPlan {
	draws: number
	decile1Draws: number
	target: number
	presenceRows: number
	decile1PresenceRows: number
	admission: number
}

/**
 * The recipe's row counts under its draw budget: the demand rows of each cell,
 * and the draws one recipe row takes per unit of admission chance, `budget / A`.
 */
export interface RecipeRowSolution {
	demandRows: number[]
	drawsPerAdmittedRow: number
	/**
	 * The recipe's admitted rows `A`: each presence and demand row at its country's admission chance.
	 */
	admittedRows: number
	/**
	 * The draws the cells lack before any recipe row: the least budget that could meet them.
	 */
	deficitDraws: number
}

/**
 * The demand rows one cell needs when each recipe row of its country takes `perRow` draws.
 */
function cellDemandRows(cell: DemandCellPlan, perRow: number): number {
	const deficit = decileOneDeficit(
		cell.draws + cell.presenceRows * perRow,
		cell.decile1Draws + cell.decile1PresenceRows * perRow,
		cell.target
	)

	return deficit > 0 ? Math.ceil(deficit / perRow - 1e-9) : 0
}

/**
 * The rounds {@linkcode solveRecipeRows} runs before it refuses.
 *
 * Each round that continues adds at least one row, so the bound stops a solve whose rows keep growing.
 */
const SOLVE_ROUNDS = 10_000

/**
 * The fewest recipe rows whose draws meet every cell when `budget` draws spread over them.
 *
 * A recipe row's draws, `budget / A`, fall as rows are added, and a cell's
 * need grows as each row draws less.
 * The first round counts only the presence rows.
 *
 * Each round raises every cell to the rows it needs at the current per-row draws and recomputes them.
 * A cell's rows never fall, so the rounds stop once every cell holds enough at the draws its rows give.
 *
 * @throws When the deficits, counted without the presence rows, take the whole budget
 * or more: no row count meets them, and the source's weight must rise.
 */
export function solveRecipeRows(
	cells: readonly DemandCellPlan[],
	presenceAdmitted: number,
	budget: number
): RecipeRowSolution {
	const floor = cells.reduce(
		(sum, cell) => sum + (cell.admission > 0 ? decileOneDeficit(cell.draws, cell.decile1Draws, cell.target) : 0),
		0
	)

	if (floor >= budget) {
		throw new Error(
			`the demand cells lack ${floor.toFixed(1)} draws, at or above the recipe's budget of ${budget.toFixed(1)}; ` +
				"raise the source's weight"
		)
	}

	const rows = cells.map(() => 0)
	let admitted = presenceAdmitted

	for (let round = 0; round < SOLVE_ROUNDS; round++) {
		// Before any row exists, the first row would take the whole budget.
		const perRow = admitted > 0 ? budget / admitted : budget
		let changed = false

		for (const [index, cell] of cells.entries()) {
			if (!(cell.admission > 0)) continue

			const need = cellDemandRows(cell, perRow * cell.admission)

			if (need > rows[index]!) {
				admitted += (need - rows[index]!) * cell.admission
				rows[index] = need
				changed = true
			}
		}

		if (!changed) {
			return { demandRows: rows, drawsPerAdmittedRow: perRow, admittedRows: admitted, deficitDraws: floor }
		}
	}

	throw new Error(`the recipe's row counts did not settle in ${SOLVE_ROUNDS} rounds`)
}

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
 * The places the recipe may write.
 */
const WRITABLE_PLACE_SQL = writablePlaceSQL()

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
	postal_pair: boolean
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
	 * Cells short of their target with no decile-1 place the recipe can write, with the draws they lack.
	 */
	unmet_cells: Array<{ country: string; band: string; query_shape: string; deficit_draws: number }>
	/**
	 * The epoch the counts are set in: its draws, the recipe source's requested share
	 * and the draws that share gives it, the draws the demand cells lack before any
	 * recipe row, and the draws one admitted recipe row takes.
	 */
	epoch: {
		draws: number
		requested_share: number
		budget_draws: number
		deficit_draws: number
		draws_per_admitted_row: number
	}
}

/**
 * Writes `prominent-tuples.jsonl` into `out` from `places.parquet` and the base corpus's
 * `short-admin-rows.parquet` there, under the training config's epoch over that base.
 *
 * @throws When the config requests no draws of the recipe's source, or the base already holds its rows.
 */
export async function writeProminentTuples(options: {
	out: string
	/**
	 * The training config's epoch over the base corpus the scan read.
	 */
	epoch: EpochMeasure
	limits?: DuckDBLimits
}): Promise<ProminentTuplesSummary> {
	const placesPath = `${options.out}/places.parquet`
	const share = options.epoch.requested.get(PROMINENT_PLACES_SOURCE)

	if (!share) {
		throw new Error(
			`the training config requests no draws of ${PROMINENT_PLACES_SOURCE}; give it a source_weights entry`
		)
	}

	if (options.epoch.trainShapes.some((row) => row.source === PROMINENT_PLACES_SOURCE)) {
		throw new Error(`the base corpus already holds ${PROMINENT_PLACES_SOURCE} rows; scan the corpus the recipe joins`)
	}

	const budget = options.epoch.draws * share

	// The base sources' rates.
	// The recipe's rows don't exist yet, and the solve below sets their draws.
	const rates = epochRates({
		...options.epoch,
		requested: new Map([...options.epoch.requested].filter(([source]) => source !== PROMINENT_PLACES_SOURCE)),
	})

	const admission = (country: string) => rates.admission.get(country) ?? 0

	const record = await readProminentPlacesRecord(placesPath)
	const countryNames = await readCandidateCountryNames(record.candidate_db)
	// A territory WOF records under no country or dependency (BQ, CC, IO) takes its English region name.
	const displayName = createDisplayCountryName()

	using db = await openDuckDB(options.limits)

	await createProminentCoverageTables(db, placesPath, `${options.out}/short-admin-rows.parquet`, rates)

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
				"SELECT spr_id, country, band, name, parent_locality, region, region_abbrs, postal_pair FROM ranked " +
					`WHERE ${WRITABLE_PLACE_SQL}`,
				(row): PlaceRow => ({
					spr_id: row.number("spr_id"),
					country: row.text("country"),
					band: row.text("band") as PlaceBand,
					name: row.text("name"),
					parent_locality: row.optionalText("parent_locality"),
					region: row.optionalText("region"),
					region_abbrs: row.textList("region_abbrs"),
					postal_pair: row.text("postal_pair") === "true",
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

	let presenceAdmitted = 0

	for (const row of placeShapes) {
		if (row.required && row.rows === 0) {
			add(row.spr_id, row.query_shape, 1)

			presenceRows++
			presenceAdmitted += admission(row.country)

			tally(row.country).presence_rows++
		}
	}

	const unmet: ProminentTuplesSummary["unmet_cells"] = []
	const demandCells: Array<{ cell: (typeof cells)[number]; members: PlaceShapeRow[]; plan: DemandCellPlan }> = []
	const unwritable: Array<{ cell: (typeof cells)[number]; plan: DemandCellPlan }> = []

	for (const cell of cells) {
		if (cell.decile1_population_share == null) continue

		const writable = placeShapesByCell.get(cellKey(cell)) ?? []
		const members = writable.filter((row) => row.decile === 1)

		// The presence rows written above count toward the cell, and a decile-1 place's toward decile 1.
		const plan: DemandCellPlan = {
			draws: cell.draws,
			decile1Draws: cell.decile1_draws,
			target: DEMAND_SHARE_FRACTION * cell.decile1_population_share,
			presenceRows: writable.filter((row) => row.required && row.rows === 0).length,
			decile1PresenceRows: members.filter((row) => row.required && row.rows === 0).length,
			admission: admission(cell.country),
		}

		if (members.length) {
			demandCells.push({ cell, members, plan })
		} else {
			unwritable.push({ cell, plan })
		}
	}

	const solution = solveRecipeRows(
		demandCells.map(({ plan }) => plan),
		presenceAdmitted,
		budget
	)

	// A cell with no writable decile-1 place keeps its deficit, counted with the draws its presence rows take.
	for (const { cell, plan } of unwritable) {
		const perRow = solution.drawsPerAdmittedRow * plan.admission

		const deficit = decileOneDeficit(
			plan.draws + plan.presenceRows * perRow,
			plan.decile1Draws + plan.decile1PresenceRows * perRow,
			plan.target
		)

		if (deficit > 0) {
			unmet.push({ country: cell.country, band: cell.band, query_shape: cell.query_shape, deficit_draws: deficit })
		}
	}

	let largestPart = 0

	for (const [cellIndex, { cell, members }] of demandCells.entries()) {
		const cellRows = solution.demandRows[cellIndex]!

		if (!cellRows) continue

		tally(cell.country).deficit += cellRows

		const parts = apportionUnderCap(
			cellRows,
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
			throw new Error(`${country} takes ${entry.demand_rows} demand rows against its own cells' ${entry.deficit}`)
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
		epoch: {
			draws: options.epoch.draws,
			requested_share: share,
			budget_draws: budget,
			deficit_draws: solution.deficitDraws,
			draws_per_admitted_row: solution.drawsPerAdmittedRow,
		},
	}
}
