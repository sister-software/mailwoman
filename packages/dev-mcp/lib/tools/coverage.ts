/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_coverage` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The census itself lives in `../coverage-census.ts`; this file is the interface.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { readScopeConfig } from "@mailwoman/core/scope-config"
import {
	censusCoverage,
	type CountryCoverage,
	type CoverageReport,
	GeocodeReading,
	geocodeReading,
	newestManifest,
	ParseReading,
	parseReading,
	resolveTrainingConfig,
} from "mailwoman/coverage"
import { z } from "zod"

import type { DevTool, DevToolDeps } from "#tool-kit"

/**
 * One country as a line a reader can act on.
 *
 * Parse and geocode stay in separate columns because they are separate capabilities
 * with wildly different coverage.
 */
function line(c: CountryCoverage): string {
	const rows = c.corpusRows.toLocaleString()

	// The wording differs from `jurisdiction-coverage.run.ts`'s table cell
	// and the reading behind it does not, because both read `parseReading`.
	// An agent reads this line without the surrounding columns, so it names the row
	// count inside the phrase rather than in a neighbouring cell.
	const parse = {
		[ParseReading.Absent]: "absent",
		[ParseReading.Declined]: "not trained",
		[ParseReading.DeclinedWithRows]: `DROPPED (${rows} rows, not admitted)`,
		[ParseReading.AdmittedEmpty]: "admitted, NO ROWS",
		[ParseReading.RowsWithStreet]: `${rows} rows (${c.corpusStreetRows.toLocaleString()} street)`,
		[ParseReading.RowsWithoutStreet]: `${rows} rows, NO STREET`,
	}[parseReading(c)]

	const geo = {
		[GeocodeReading.Absent]: "none",
		[GeocodeReading.Rooftop]: "rooftop",
		[GeocodeReading.Locality]: `locality (${c.gazetteerPlaces.toLocaleString()})`,
		[GeocodeReading.None]: "none",
	}[geocodeReading(c)]

	const board = c.boardRows ? `${c.boardPassedRows}/${c.boardRows} conditional` : "unmeasured"

	return `${c.country} | parse: ${parse} | geocode: ${geo} | board: ${board}${c.weightsPackage ? ` | pkg: ${c.weightsPackage}` : ""}`
}

export const coverageTool = async (_deps: DevToolDeps): Promise<DevTool> => ({
	name: "mwdev_coverage",
	description:
		"What can mailwoman actually do, per country — parse and geocode kept APART, from primary sources. Answers " +
		"the question that sounds like one question and is five, held in five places that do not agree: a weights " +
		"package exists (says nothing about training — only en-us ships a model.onnx, the rest are data-only " +
		"overlays), the corpus holds rows (a country can hold 11M rows and none of them a street), the training " +
		"config ADMITS the country (`country_weights` is a hard filter, so a country absent from it trains on nothing " +
		"— the Norway bug's mechanism), the gazetteer can resolve it (244 countries, a much wider set), and the board " +
		"measures it (rows that are not `status: pass` track rather than check). Reports the four ways those disagree " +
		"explicitly. Corpus counts are CACHED — pass refresh to recount, which costs minutes. Call this before " +
		"claiming any country is or is not supported.",
	inputSchema: z.object({
		countries: z
			.array(z.string().length(2))
			.min(1)
			.max(60)
			.optional()
			.describe("ISO alpha-2 codes to report on. Omit for the mismatch summary plus the countries that train."),
		refresh: z
			.boolean()
			.optional()
			.describe(
				"Recount the corpus instead of reading the cache. Exact, and costs minutes — a full read of every train " +
					"extract. Do this after building a new corpus version, not routinely."
			),
		config: z
			.string()
			.optional()
			.describe(
				"Training config path whose `country_weights` decides admission. Defaults to the config `scope.config.json` " +
					"records for the Latin family's shipped graph, which admits 25 countries. The v5.9.0 in-flight config " +
					"admits 135, so name it when the question is what a next run would train."
			),
	}),
	handler: async (args) => {
		const config = resolveTrainingConfig(await readScopeConfig(), {
			requested: args["config"] as string | undefined,
		})

		const configPath = config.path
		const manifestPath = await newestManifest()

		if (!configPath || !manifestPath) {
			return {
				error: "no config or corpus manifest found",
				configPath,
				manifestPath,
				summary:
					"Could not locate a training config or a corpus manifest. That is an ABSENCE of files, not of coverage — " +
					"check the repo root and data root before concluding anything.",
			}
		}

		const report = await censusCoverage({
			configPath,
			manifestPath,
			casesRoot: `${String(repoRootPath())}/packages/mailwoman/lib/eval-harness/gauntlet/cases`,
			refresh: args["refresh"] === true,
		})

		return projectCoverage(report, args["countries"] as string[] | undefined)
	},
})

/**
 * Project a {@linkcode CoverageReport} into the tool's response shape.
 *
 * Pure and exported so the projection can be tested.
 * It builds its result field by field, which means a field the report grows and this function
 * does not name is dropped in silence, and the consumer reads that as the field not existing.
 *
 * The corpus-mismatch guard shipped inert for exactly that reason: the census computed it,
 * fifteen tests passed, and the first live call showed nothing, because this function did not carry it.
 */
export function projectCoverage(report: CoverageReport, wantedCountries?: string[]): Record<string, unknown> {
	const wanted = wantedCountries?.map((c) => c.toUpperCase())
	const trains = (c: CountryCoverage): boolean => c.admitted && c.corpusRows > 0

	const shown = wanted
		? report.countries.filter((c) => wanted.includes(c.country))
		: report.countries.filter((c) => trains(c)).toSorted((a, b) => b.corpusRows - a.corpusRows)

	const missing = wanted?.filter((cc) => !report.countries.some((c) => c.country === cc)) ?? []
	const trained = report.countries.filter(trains)
	const withStreet = trained.filter((c) => c.corpusStreetRows > 0)

	return {
		corpus_version: report.corpusVersion,
		...(report.configuredCorpusVersion ? { configured_corpus_version: report.configuredCorpusVersion } : {}),
		...(report.corpusMismatch ? { corpus_mismatch: report.corpusMismatch } : {}),
		corpus_rows_total: report.corpusRowsTotal,
		corpus_census_taken_at: report.corpusCensusTakenAt ?? "just now (recounted)",
		config: report.configPath,
		// This tool takes no manifest argument, so the corpus was chosen rather than named.
		// Saying so lets a reader tell a census of the corpus they meant from a census
		// of whichever one was written to most recently (#2349).
		manifest_chosen_by: "newest modification time under the data root",
		n_trained: trained.length,
		n_trained_with_street_data: withStreet.length,
		n_geocodable: report.countries.filter((c) => c.gazetteerPlaces > 0).length,
		rows: shown,
		rendered: shown.map(line),
		...(missing.length ? { requested_but_absent_everywhere: missing } : {}),
		mismatches: report.mismatches,
		summary:
			// A mismatch leads. A caller reads the first sentence, and every count after it is about a corpus the run does not read.
			(report.corpusMismatch ? `CORPUS MISMATCH — ${report.corpusMismatch} ` : "") +
			`${trained.length} countries train (${withStreet.length} with street-level rows); ` +
			`${report.countries.filter((c) => c.gazetteerPlaces > 0).length} are geocodable to a locality, ` +
			`2 to a rooftop a consumer can obtain (US, FR). ` +
			(report.mismatches.presentButDropped.length
				? `SILENTLY DROPPED — corpus rows, not admitted by \`country_weights\`: ${report.mismatches.presentButDropped.join(", ")}. `
				: "") +
			(report.mismatches.packageWithoutTraining.length
				? `Ships a locale package but was never trained: ${report.mismatches.packageWithoutTraining.join(", ")}. `
				: "") +
			(report.corpusCensusTakenAt
				? `Corpus counts are CACHED from ${report.corpusCensusTakenAt} — pass refresh after building a new corpus.`
				: "Corpus counts were recounted in this call."),
		notes: report.notes,
	}
}
