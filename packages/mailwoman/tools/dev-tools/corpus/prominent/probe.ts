// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The prominent-places census report, its geocode sample and the grading of that sample.
 *
 *   The sample takes, per country and band, the top-ranked prominent place and further prominent
 *   places in `hash(spr_id)` order, and writes each in every shape it has a second segment for.
 *   Each input is geocoded under en-US and under the shipped weights package whose
 *   region subtag is the place's country, when one exists.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { writeLocalJSONLFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readReleaseConfig, weightsPackageByCountry } from "@mailwoman/core/repo/release-config"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { isPresent } from "@mailwoman/core/values/objects"
import { type DuckDBLimits, escapeSQLString, openDuckDB } from "@mailwoman/corpus/parquet/duckdb"
import { QUERY_SHAPES, type QueryShape } from "@mailwoman/corpus/recipes/prominent/places"
import { DEFAULT_WEIGHTS_LOCALE } from "@mailwoman/neural/weights/families"
import { foldNFKCWhitespace } from "@mailwoman/normalize/fold"
import { haversine } from "@mailwoman/spatial/geometries/point/distance"
import { resolvePath } from "path-ts"
import { JSONSpliterator } from "spliterator"

function quoted(value: string): string {
	return `'${escapeSQLString(value)}'`
}

async function rowsOf<T>(db: Awaited<ReturnType<typeof openDuckDB>>, sql: string): Promise<T[]> {
	return (await db.runAndReadAll(sql)).getRowObjectsJson() as T[]
}

function table(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
	return [
		`| ${header.join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
		...rows.map((row) => `| ${row.join(" | ")} |`),
	].join("\n")
}

function percent(part: number, whole: number): string {
	return whole ? `${((100 * part) / whole).toFixed(1)}%` : "n/a"
}

// #region Report

/**
 * Renders the prominence distribution and the coverage tables as markdown,
 * and writes the per-country tables to `report-countries.md` beside them.
 */
export async function renderProminenceReport(options: { out: string; limits?: DuckDBLimits }): Promise<string> {
	using db = await openDuckDB(options.limits)

	await db.run(`CREATE TABLE p AS SELECT * FROM read_parquet(${quoted(`${options.out}/places.parquet`)})`)
	await db.run(`CREATE TABLE c AS SELECT * FROM read_parquet(${quoted(`${options.out}/coverage.parquet`)})`)

	const sections: string[] = []

	const sources = await rowsOf<{ band: string; score_source: string; n: number }>(
		db,
		"SELECT band, score_source, count(*)::INTEGER AS n FROM p GROUP BY ALL ORDER BY band, n DESC"
	)

	sections.push(
		"## Score sources, every primary place\n\n" +
			table(
				["band", "score source", "places"],
				sources.map((row) => [row.band, row.score_source, row.n])
			)
	)

	const perCountry = await rowsOf<{
		country: string
		band: string
		places: number
		scored: number
		selected: number
		capitals: number
		postal: number
	}>(
		db,
		"SELECT country, band, count(*)::INTEGER AS places, count(rank)::INTEGER AS scored, " +
			"count(*) FILTER (WHERE by_rank OR capital)::INTEGER AS selected, count(*) FILTER (WHERE capital)::INTEGER AS capitals, " +
			"count(*) FILTER (WHERE (by_rank OR capital) AND postal_name)::INTEGER AS postal FROM p GROUP BY ALL ORDER BY country, band"
	)

	const buckets = [
		[0, 0],
		[1, 4],
		[5, 5],
		[6, 10],
		[11, 25],
		[26, 50],
		[51, 99],
		[100, 100],
		[101, Number.POSITIVE_INFINITY],
	] as const

	const distribution = (["locality", "sublocality"] as const).map((band) => {
		const rows = perCountry.filter((row) => row.band === band)

		return [
			band,
			rows.length,
			...buckets.map(([low, high]) => rows.filter((row) => row.selected >= low && row.selected <= high).length),
			rows.reduce((sum, row) => sum + row.selected, 0),
		]
	})

	sections.push(
		"## Places selected per country (rank within country and band, plus the national capital)\n\n" +
			table(
				[
					"band",
					"countries",
					...buckets.map(([l, h]) => (l === h ? `${l}` : h === Number.POSITIVE_INFINITY ? `>${l - 1}` : `${l}-${h}`)),
					"total",
				],
				distribution
			)
	)

	const capitals = await rowsOf<{ countries: number; matched: number }>(
		db,
		"SELECT count(DISTINCT country)::INTEGER AS countries, count(DISTINCT country) FILTER (WHERE capital)::INTEGER AS matched FROM p"
	)

	sections.push(
		`National capital matched to a ranked place in ${capitals[0]!.matched} of ${capitals[0]!.countries} countries with places.`
	)

	const coverage = await rowsOf<{
		band: string
		query_shape: string
		prominent: boolean
		places: number
		covered: number
		expected: number
		rows: number
	}>(
		db,
		"SELECT band, query_shape, prominent, sum(places)::INTEGER AS places, sum(covered)::INTEGER AS covered, " +
			"sum(covered_expected_tag)::INTEGER AS expected, sum(rows)::BIGINT AS rows FROM c WHERE decile IS NOT NULL OR prominent " +
			"GROUP BY ALL ORDER BY band, query_shape, prominent DESC"
	)

	sections.push(
		"## Corpus coverage, pooled over countries\n\n" +
			table(
				["band", "shape", "set", "places", "with a train row", "with the expected tag", "train rows"],
				coverage.map((row) => [
					row.band,
					row.query_shape,
					row.prominent ? "prominent" : "other ranked",
					row.places,
					percent(row.covered, row.places),
					percent(row.expected, row.places),
					row.rows,
				])
			)
	)

	const countryShare = await rowsOf<{
		band: string
		query_shape: string
		countries: number
		zero: number
		p25: number
		median: number
		p75: number
	}>(
		db,
		"WITH s AS (SELECT country, band, query_shape, sum(covered_expected_tag) / sum(places) AS share FROM c WHERE prominent " +
			"GROUP BY ALL) SELECT band, query_shape, count(*)::INTEGER AS countries, count(*) FILTER (WHERE share = 0)::INTEGER AS zero, " +
			"quantile_disc(share, 0.25) AS p25, quantile_disc(share, 0.5) AS median, quantile_disc(share, 0.75) AS p75 FROM s GROUP BY ALL ORDER BY band, query_shape"
	)

	sections.push(
		"## Per-country share of prominent places with a train row under the expected tag\n\n" +
			table(
				["band", "shape", "countries", "countries at 0", "p25", "median", "p75"],
				countryShare.map((row) => [
					row.band,
					row.query_shape,
					row.countries,
					row.zero,
					percent(row.p25, 1),
					percent(row.median, 1),
					percent(row.p75, 1),
				])
			)
	)

	const deciles = await rowsOf<{ band: string; query_shape: string; decile: number; places: number; expected: number }>(
		db,
		"SELECT band, query_shape, decile, sum(places)::INTEGER AS places, sum(covered_expected_tag)::INTEGER AS expected " +
			"FROM c WHERE decile IS NOT NULL GROUP BY ALL ORDER BY band, query_shape, decile"
	)

	const decileRows: Array<Array<string | number>> = []

	for (const band of ["locality", "sublocality"]) {
		for (const shape of QUERY_SHAPES) {
			const cells = deciles.filter((row) => row.band === band && row.query_shape === shape)

			if (!cells.length) continue

			decileRows.push([
				band,
				shape,
				...Array.from({ length: 10 }, (_, i) => {
					const cell = cells.find((row) => Number(row.decile) === i + 1)

					return cell ? percent(cell.expected, cell.places) : "n/a"
				}),
			])
		}
	}

	sections.push(
		"## Share of ranked places with a train row under the expected tag, by prominence decile (1 = most prominent)\n\n" +
			table(["band", "shape", ...Array.from({ length: 10 }, (_, i) => `d${i + 1}`)], decileRows)
	)

	// A row writes the place under the band's expected tag: locality, or either tag for a sub-locality.
	const expectedRows = "rows_locality + CASE WHEN band = 'sublocality' THEN rows_dependent_locality ELSE 0 END"

	const demand = await rowsOf<{
		band: string
		query_shape: string
		countries: number
		with_rows: number
		population_d1: number
		rows_d1: number
		meets_half: number
	}>(
		db,
		`WITH pop AS (SELECT country, band, sum(population_used) FILTER (WHERE decile = 1) / sum(population_used) AS share ` +
			"FROM p WHERE decile IS NOT NULL GROUP BY ALL), " +
			`r AS (SELECT country, band, query_shape, (sum(${expectedRows}) FILTER (WHERE decile = 1))::DOUBLE / ` +
			`nullif(sum(${expectedRows}), 0) AS share FROM read_parquet(${quoted(`${options.out}/place-shapes.parquet`)}) ` +
			"WHERE decile IS NOT NULL GROUP BY ALL) " +
			"SELECT r.band, r.query_shape, count(*)::INTEGER AS countries, count(r.share)::INTEGER AS with_rows, " +
			"median(pop.share) AS population_d1, median(coalesce(r.share, 0)) AS rows_d1, " +
			"count(*) FILTER (WHERE coalesce(r.share, 0) >= pop.share / 2)::INTEGER AS meets_half " +
			"FROM r JOIN pop USING (country, band) GROUP BY ALL ORDER BY r.band, r.query_shape"
	)

	sections.push(
		"## Decile 1's share of the country's population against its share of the shape's train rows\n\n" +
			"Per country and band, the top decile's share of the population of every ranked place, beside its share of the " +
			"train rows that write a ranked place in the shape under the expected tag. A country with no such row reads 0.\n\n" +
			table(
				[
					"band",
					"shape",
					"countries",
					"with rows",
					"median population share",
					"median row share",
					"row share at least half the population share",
				],
				demand.map((row) => [
					row.band,
					row.query_shape,
					row.countries,
					row.with_rows,
					percent(row.population_d1, 1),
					percent(row.rows_d1, 1),
					row.meets_half,
				])
			)
	)

	const byCountry = await rowsOf<{
		country: string
		band: string
		query_shape: string
		places: number
		expected: number
	}>(
		db,
		"SELECT country, band, query_shape, sum(places)::INTEGER AS places, sum(covered_expected_tag)::INTEGER AS expected " +
			"FROM c WHERE prominent GROUP BY ALL ORDER BY country, band, query_shape"
	)

	const countryLines: Array<Array<string | number>> = []

	for (const row of perCountry) {
		const cells = byCountry.filter((cell) => cell.country === row.country && cell.band === row.band)

		countryLines.push([
			row.country,
			row.band,
			row.places,
			row.scored,
			row.selected,
			row.capitals,
			row.postal,
			...QUERY_SHAPES.map((shape) => {
				const cell = cells.find((entry) => entry.query_shape === shape)

				return cell ? `${cell.expected}/${cell.places}` : "-"
			}),
		])
	}

	await writeLocalTextFile(
		"# Prominent places per country\n\nCoverage cells read places with a train row under the expected tag, over prominent places with that shape.\n\n" +
			table(
				["country", "band", "places", "ranked", "selected", "capital", "postal name", ...QUERY_SHAPES],
				countryLines
			) +
			"\n",
		resolvePath(options.out, "report-countries.md")
	)

	return sections.join("\n\n") + "\n"
}

// #endregion

// #region Geocode sample

/**
 * One geocode input and what a correct answer holds.
 */
export interface ProbeInput {
	id: string
	spr_id: number
	country: string
	band: string
	rank: number | null
	prominent: boolean
	postal_name: boolean
	shape: QueryShape
	input: string
	/**
	 * The tags any one of which may hold the place's name.
	 */
	place_tags: string[]
	place: string
	/**
	 * The tag and values the second segment must be read as, or `null` for a bare input.
	 */
	second: { tag: string; values: string[] } | null
	/**
	 * A second correct reading, or `null`.
	 *
	 * When a sub-locality's parent locality and region share a name
	 * (`Brooklyn, New York`, `Wieden, Wien`), the second segment may be read as either,
	 * and the place as a dependent locality beside the locality or as a locality beside the region.
	 */
	alternate: { place_tags: string[]; second: { tag: string; values: string[] } } | null
	lat: number
	lon: number
	tolerance_km: number
	locales: string[]
	/**
	 * The countries holding a higher-scored place of the same folded name.
	 */
	outranked_by: string[]
}

const DISPLAY_COUNTRY = new Intl.DisplayNames(["en"], { type: "region" })

/**
 * The failure examples the grade report lists per band and shape, one per country.
 */
const EXAMPLES_PER_SHAPE = 4

/**
 * Draws the geocode sample from `places.parquet` and writes `inputs.jsonl`
 * and one `inputs-<locale>.txt` per locale.
 *
 * `include` names further WOF ids to sample whether or not they're prominent,
 * so a known case stays in the sample.
 * Each one is marked with its own prominence.
 */
export async function drawGeocodeInputs(options: {
	out: string
	perBand: number
	include?: readonly number[]
	limits?: DuckDBLimits
}): Promise<{ inputs: number; locales: Record<string, number> }> {
	const packages = weightsPackageByCountry(await readReleaseConfig())

	using db = await openDuckDB(options.limits)

	const include = options.include?.length ? options.include.join(", ") : "NULL"

	const places = await rowsOf<{
		spr_id: number
		country: string
		band: string
		name: string
		rank: number | null
		prominent: boolean
		postal_name: boolean
		parent_locality: string | null
		region: string | null
		region_abbrs: string[] | null
		lat: number
		lon: number
		min_lat: number | null
		min_lon: number | null
		max_lat: number | null
		max_lon: number | null
		outranked_by: string[] | null
	}>(
		db,
		`WITH p AS (SELECT *, (by_rank OR capital) AS prominent FROM read_parquet(${quoted(`${options.out}/places.parquet`)})), ` +
			"d AS (SELECT *, row_number() OVER (PARTITION BY country, band ORDER BY (rank = 1) DESC, capital DESC, hash(spr_id)) AS draw " +
			"FROM p WHERE prominent), " +
			`s AS (SELECT * FROM d WHERE draw <= ${options.perBand} UNION ALL SELECT *, NULL AS draw FROM p ` +
			`WHERE spr_id IN (${include}) AND spr_id NOT IN (SELECT spr_id FROM d WHERE draw <= ${options.perBand})), ` +
			// The countries that hold a higher-scored place of the same folded name.
			// A bare input may rightly name that place.
			"h AS (SELECT s.spr_id, list(DISTINCT o.country ORDER BY o.country) AS outranked_by FROM s JOIN p o ON o.fold = s.fold " +
			"AND o.spr_id <> s.spr_id AND o.score > coalesce(s.score, -1) GROUP BY s.spr_id) " +
			"SELECT s.spr_id, country, band, name, rank, prominent, postal_name, parent_locality, region, region_abbrs, lat, lon, " +
			"min_lat, min_lon, max_lat, max_lon, h.outranked_by FROM s LEFT JOIN h ON h.spr_id = s.spr_id " +
			"ORDER BY country, band, rank NULLS LAST"
	)

	const inputs: ProbeInput[] = []

	for (const place of places) {
		const locales: string[] = [DEFAULT_WEIGHTS_LOCALE]
		const own = packages.get(place.country)

		if (own && own.toLowerCase() !== DEFAULT_WEIGHTS_LOCALE.toLowerCase()) {
			const [language, region] = own.split("-")

			locales.push(`${language}-${region!.toUpperCase()}`)
		}

		const halfDiagonal =
			place.min_lat == null || place.max_lat == null || place.min_lon == null || place.max_lon == null
				? 0
				: haversine(place.min_lat, place.min_lon, place.max_lat, place.max_lon) / 2

		const placeTags = place.band === "locality" ? ["locality"] : ["locality", "dependent_locality"]

		const sharedName =
			place.band === "sublocality" &&
			place.parent_locality != null &&
			place.region != null &&
			foldNFKCWhitespace(place.parent_locality) === foldNFKCWhitespace(place.region)

		const countryName = DISPLAY_COUNTRY.of(place.country) ?? place.country

		const forms: Array<{ shape: QueryShape; second: ProbeInput["second"]; text: string | null; tags?: string[] }> = [
			{ shape: "bare", second: null, text: "" },
			{
				shape: "parent",
				second: place.parent_locality ? { tag: "locality", values: [place.parent_locality] } : null,
				text: place.band === "sublocality" ? place.parent_locality : null,
				tags: ["dependent_locality"],
			},
			{
				shape: "region",
				second: place.region ? { tag: "region", values: [place.region] } : null,
				text: place.region,
			},
			{
				shape: "region_abbr",
				second: place.region_abbrs?.length
					? { tag: "region", values: [place.region_abbrs[0]!, place.region ?? ""] }
					: null,
				text: place.region_abbrs?.[0] ?? null,
			},
			{ shape: "country", second: { tag: "country", values: [countryName, place.country] }, text: countryName },
		]

		for (const form of forms) {
			if (form.text == null) continue

			if (form.shape !== "bare" && !form.second) continue

			// A second segment that repeats the place reads as one name written twice.
			if (form.text && foldNFKCWhitespace(form.text) === foldNFKCWhitespace(place.name)) continue

			inputs.push({
				id: `${place.country}:${place.spr_id}:${form.shape}`,
				spr_id: Number(place.spr_id),
				country: place.country,
				band: place.band,
				rank: place.rank == null ? null : Number(place.rank),
				prominent: place.prominent,
				postal_name: place.postal_name,
				shape: form.shape,
				input: form.text ? `${place.name}, ${form.text}` : place.name,
				place_tags: form.tags ?? placeTags,
				place: place.name,
				second: form.shape === "bare" ? null : form.second,
				alternate:
					sharedName && form.shape === "parent"
						? { place_tags: ["locality", "dependent_locality"], second: { tag: "region", values: [place.region!] } }
						: sharedName && form.shape === "region"
							? { place_tags: ["dependent_locality"], second: { tag: "locality", values: [place.parent_locality!] } }
							: null,
				lat: place.lat,
				lon: place.lon,
				tolerance_km: Math.max(5, Math.min(50, halfDiagonal)),
				locales,
				outranked_by: place.outranked_by ?? [],
			})
		}
	}

	await writeLocalJSONLFile(inputs, resolvePath(options.out, "inputs.jsonl"))

	const byLocale = new Map<string, Set<string>>()

	for (const input of inputs) {
		for (const locale of input.locales) {
			const set = byLocale.get(locale) ?? new Set<string>()

			set.add(input.input)
			byLocale.set(locale, set)
		}
	}

	for (const [locale, set] of byLocale) {
		await writeLocalTextFile([...set].join("\n") + "\n", resolvePath(options.out, `inputs-${locale}.txt`))
	}

	return {
		inputs: inputs.length,
		locales: Object.fromEntries([...byLocale].map(([locale, set]) => [locale, set.size])),
	}
}

interface GeocodeOutput {
	input: string
	components: Record<string, string> | null
	lat: number | null
	lon: number | null
	countryCode: string | null
	hierarchy?: Array<{ placeID?: string | null }> | null
	engine?: { version?: string }
}

/**
 * One graded input under one locale.
 */
export interface ProbeGrade {
	id: string
	locale: string
	country: string
	band: string
	shape: QueryShape
	prominent: boolean
	postal_name: boolean
	input: string
	geo: boolean
	components: boolean
	coherent: boolean
	pass: boolean
	/**
	 * A bare input whose name a higher-scored place also holds: in any country under en-US,
	 * or in the place's own country under its own locale.
	 *
	 * Another answer may be right, so the row is reported apart from the failure rate.
	 */
	ambiguous: boolean
	km: number | null
	observed: Record<string, string> | null
	observed_country: string | null
}

function hasValue(components: Record<string, string>, tags: readonly string[], values: readonly string[]): boolean {
	const wanted = new Set(values.filter((value) => value.length > 0).map(foldNFKCWhitespace))

	return tags.some((tag) => {
		const value = components[tag]

		return typeof value === "string" && wanted.has(foldNFKCWhitespace(value))
	})
}

/**
 * Grades `geocoded-<locale>.jsonl` against `inputs.jsonl`, writes `grades.jsonl`,
 * and returns the failure tables as markdown.
 *
 * A row passes when its point lies within its tolerance of the place's WOF centroid,
 * or its hierarchy holds the place's WOF id, and its components hold the place under
 * an accepted tag and the second segment under its tag.
 * A dependent locality without a locality is incoherent and fails.
 *
 * @throws When a locale's output file is missing or lacks an input the sample holds.
 */
export async function gradeGeocodes(options: { out: string }): Promise<string> {
	const inputs = await JSONSpliterator.fromAsync<ProbeInput>(resolvePath(options.out, "inputs.jsonl")).toArray()

	const locales = [...new Set(inputs.flatMap((input) => input.locales))]
	const outputs = new Map<string, Map<string, GeocodeOutput>>()
	const engines = new Set<string>()

	for (const locale of locales) {
		const path = resolvePath(options.out, `geocoded-${locale}.jsonl`)

		if (!(await pathExists(path))) {
			throw new Error(
				`${path.toString()} is missing; geocode inputs-${locale}.txt with --stdin --json --locale ${locale}`
			)
		}

		const rows = new Map<string, GeocodeOutput>()

		for await (const row of JSONSpliterator.fromAsync<GeocodeOutput>(path)) {
			rows.set(row.input, row)

			if (row.engine?.version) {
				engines.add(row.engine.version)
			}
		}

		outputs.set(locale, rows)
	}

	const grades: ProbeGrade[] = []

	for (const input of inputs) {
		for (const locale of input.locales) {
			const output = outputs.get(locale)!.get(input.input)

			if (!output) throw new Error(`geocoded-${locale}.jsonl holds no answer for ${stringifyJSON(input.input)}`)

			const components = output.components ?? {}
			const km = haversine(input.lat, input.lon, output.lat, output.lon)
			const inHierarchy = (output.hierarchy ?? []).some((node) => node.placeID === `wof:${input.spr_id}`)
			const geo = inHierarchy || (km != null && km <= input.tolerance_km)

			const carries = (expected: ProbeInput["second"]) =>
				!expected ||
				(expected.tag === "country"
					? output.countryCode === input.country || hasValue(components, ["country"], expected.values)
					: hasValue(components, [expected.tag], expected.values))

			const coherent = !("dependent_locality" in components) || "locality" in components

			const named =
				(hasValue(components, input.place_tags, [input.place]) && carries(input.second)) ||
				(input.alternate != null &&
					hasValue(components, input.alternate.place_tags, [input.place]) &&
					carries(input.alternate.second))

			grades.push({
				id: input.id,
				locale,
				country: input.country,
				band: input.band,
				shape: input.shape,
				prominent: input.prominent,
				postal_name: input.postal_name,
				input: input.input,
				geo,
				components: named,
				coherent,
				pass: geo && named && coherent,
				// The probe grades each place under the default weights locale
				// and under its country's own weights.
				// Under the default locale a bare name competes with every country.
				// Under its own locale it competes inside its country.
				ambiguous:
					input.shape === "bare" &&
					(locale === DEFAULT_WEIGHTS_LOCALE
						? input.outranked_by.length > 0
						: input.outranked_by.includes(input.country)),
				km: km == null ? null : Math.round(km * 10) / 10,
				observed: output.components,
				observed_country: output.countryCode,
			})
		}
	}

	await writeLocalJSONLFile(grades, resolvePath(options.out, "grades.jsonl"))

	const sections: string[] = [
		`Engine version(s): ${[...engines].join(", ") || "unstated"}. ${grades.length} graded rows.`,
	]

	// The default weights locale is one arm of the probe, and every other locale is a country's own arm.
	const localeKind = (grade: ProbeGrade) => (grade.locale === DEFAULT_WEIGHTS_LOCALE ? DEFAULT_WEIGHTS_LOCALE : "own")

	const shapeRows: Array<Array<string | number>> = []

	for (const band of ["locality", "sublocality"]) {
		for (const shape of QUERY_SHAPES) {
			for (const kind of [DEFAULT_WEIGHTS_LOCALE, "own"]) {
				const all = grades.filter((g) => g.band === band && g.shape === shape && localeKind(g) === kind)
				const cell = all.filter((g) => !g.ambiguous)

				if (!all.length) continue

				const fail = cell.filter((g) => !g.pass)

				shapeRows.push([
					band,
					shape,
					kind,
					all.length - cell.length,
					cell.length,
					`${fail.length} (${percent(fail.length, cell.length)})`,
					cell.filter((g) => !g.geo).length,
					cell.filter((g) => !g.components).length,
					cell.filter((g) => !g.coherent).length,
				])
			}
		}
	}

	sections.push(
		"## Failures by band, shape and locale\n\n" +
			table(
				[
					"band",
					"shape",
					"locale",
					"ambiguous (apart)",
					"graded rows",
					"failed",
					"wrong place",
					"wrong components",
					"incoherent",
				],
				shapeRows
			)
	)

	const countries = [...new Set(grades.map((g) => g.country))].toSorted()

	const countryRows = countries
		.map((country) => {
			const cell = grades.filter((g) => g.country === country && !g.ambiguous)
			const us = cell.filter((g) => g.locale === DEFAULT_WEIGHTS_LOCALE)
			const own = cell.filter((g) => g.locale !== DEFAULT_WEIGHTS_LOCALE)

			return {
				country,
				rows: cell.length,
				usFail: us.filter((g) => !g.pass).length,
				us: us.length,
				ownFail: own.filter((g) => !g.pass).length,
				own: own.length,
				worst: QUERY_SHAPES.map((shape) => {
					const s = cell.filter((g) => g.shape === shape)

					return s.length ? `${s.filter((g) => !g.pass).length}/${s.length}` : "-"
				}),
			}
		})
		.filter((row) => row.us > 0)
		.toSorted((a, b) => b.usFail / b.us - a.usFail / a.us)

	await writeLocalTextFile(
		"# Geocode failures per country\n\n" +
			table(
				["country", "rows", `${DEFAULT_WEIGHTS_LOCALE} failed`, "own-locale failed", ...QUERY_SHAPES],
				countryRows.map((row) => [
					row.country,
					row.rows,
					`${row.usFail}/${row.us}`,
					row.own ? `${row.ownFail}/${row.own}` : "-",
					...row.worst,
				])
			) +
			"\n",
		resolvePath(options.out, "grades-countries.md")
	)

	const examples: Array<Array<string | number>> = []

	for (const band of ["locality", "sublocality"]) {
		for (const shape of QUERY_SHAPES) {
			const failed = grades.filter((g) => g.band === band && g.shape === shape && !g.pass && !g.ambiguous)

			// The first failures in country order, one per country, so a single country can't fill the list.
			const seen = new Set<string>()

			for (const g of failed) {
				if (seen.has(g.country) || seen.size >= EXAMPLES_PER_SHAPE) continue

				seen.add(g.country)

				examples.push([
					band,
					shape,
					g.locale,
					`\`${g.input}\``,
					`\`${stringifyJSON(g.observed ?? {})}\``,
					g.observed_country ?? "-",
					g.km ?? "-",
					[g.geo ? null : "place", g.components ? null : "components", g.coherent ? null : "incoherent"]
						.filter(isPresent)
						.join(", "),
				])
			}
		}
	}

	sections.push(
		"## Failure examples\n\n" +
			table(["band", "shape", "locale", "input", "observed components", "country", "km", "wrong"], examples)
	)

	const rates = countryRows.map((row) => row.usFail / row.us).toSorted((a, b) => a - b)
	const quantile = (q: number) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))] ?? 0

	sections.push(
		`## Per-country ${DEFAULT_WEIGHTS_LOCALE} failure rate, ambiguous bare rows excluded\n\n${countryRows.length} countries: p25 ${percent(quantile(0.25), 1)}, ` +
			`median ${percent(quantile(0.5), 1)}, p75 ${percent(quantile(0.75), 1)}, ` +
			`${rates.filter((rate) => rate === 0).length} at 0, ${rates.filter((rate) => rate >= 0.5).length} at or above 50%.`
	)

	return sections.join("\n\n") + "\n"
}

// #endregion
