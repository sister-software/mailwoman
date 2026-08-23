/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwdev_coverage` tool definition — the description an agent reads, the input schema, and the handler wiring.
 *   The census itself lives in `../coverage-census.ts`; this file is the CONTRACT.
 */

import { existsSync, readdirSync, statSync } from "node:fs"

import { dataRootPath, repoRootPath } from "@mailwoman/core/utils"
import { censusCoverage, type CountryCoverage, type CoverageReport } from "mailwoman/coverage-census"
import { z } from "zod"

import type { DevTool, DevToolDeps } from "../tool-kit.ts"

/**
 * The training config whose `country_weights` decides admission, chosen by MODIFICATION TIME.
 *
 * Not by filename. The version scheme does not sort lexically and does not sort numerically either — `v8-leg2-sp.yaml`
 * wins both against `v4.8.0-trailing-region-placement-8k.yaml`, because `v8` was a corpus-line experiment and `v4.x` is
 * the current model line. Measured: the filename sort picked `v8-leg2-sp` and reported every country as DROPPED, which
 * reads as a catastrophic finding rather than as the wrong file.
 *
 * Mtime is a proxy and can be wrong after a checkout, so the report always names the config it used. Pass one
 * explicitly when the answer matters.
 */
function newestConfig(repoRoot: string): string {
	const dir = `${repoRoot}/corpus-python/src/mailwoman_train/configs`

	if (!existsSync(dir)) return ""

	const named = readdirSync(dir)
		.filter((n) => n.endsWith(".yaml") && !n.includes("smoke"))
		.map((n) => ({ n, at: statSync(`${dir}/${n}`).mtimeMs }))
		.toSorted((a, b) => b.at - a.at)

	return named.length ? `${dir}/${named[0]!.n}` : ""
}

/**
 * The newest corpus manifest, by MODIFICATION TIME.
 *
 * Not by directory name. Corpus versions are `v0.9.9-si-bare-village`, `v0.26.0-trailing-region-leftcontext`,
 * `v8-jp-full-…` — a set that sorts neither lexically (`v0.9.9` beats `v0.26.0`, because `9` > `2`) nor numerically
 * (`v8` beats both). Measured: the name sort picked `v0.9.9` and reported the coverage of a corpus nine versions old,
 * with nothing in the output to say it had. The report always names the manifest it used.
 */
function newestManifest(): string {
	const root = String(dataRootPath("corpus", "versioned"))

	if (!existsSync(root)) return ""

	const found: Array<{ path: string; at: number }> = []

	for (const version of readdirSync(root)) {
		for (const inner of readdirSync(`${root}/${version}`)) {
			const candidate = `${root}/${version}/${inner}/MANIFEST.json`

			if (existsSync(candidate)) {
				found.push({ path: candidate, at: statSync(candidate).mtimeMs })
			}
		}
	}

	return found.toSorted((a, b) => b.at - a.at)[0]?.path ?? ""
}

/**
 * One country as a line a reader can act on. Parse and geocode stay in separate columns because they are separate
 * capabilities with wildly different coverage.
 */
function line(c: CountryCoverage): string {
	const parse = !c.admitted
		? c.corpusRows > 0
			? `DROPPED (${c.corpusRows.toLocaleString()} rows, not admitted)`
			: "not trained"
		: c.corpusRows === 0
			? "admitted, NO ROWS"
			: c.corpusStreetRows > 0
				? `${c.corpusRows.toLocaleString()} rows (${c.corpusStreetRows.toLocaleString()} street)`
				: `${c.corpusRows.toLocaleString()} rows, NO STREET`

	const geo =
		c.geocodeTier === "rooftop-published"
			? "rooftop"
			: c.gazetteerPlaces > 0
				? `locality (${c.gazetteerPlaces.toLocaleString()})`
				: "none"

	const board = c.boardRows ? `${c.boardGatedRows}/${c.boardRows} gated` : "unmeasured"

	return `${c.country} | parse: ${parse} | geocode: ${geo} | board: ${board}${c.weightsPackage ? ` | pkg: ${c.weightsPackage}` : ""}`
}

export const coverageTool = (_deps: DevToolDeps): DevTool => ({
	name: "mwdev_coverage",
	description:
		"What can mailwoman actually do, per country — parse and geocode kept APART, from primary sources. Answers " +
		"the question that sounds like one question and is five, held in five places that do not agree: a weights " +
		"package exists (says nothing about training — only en-us ships a model.onnx, the rest are data-only " +
		"overlays), the corpus holds rows (a country can hold 11M rows and none of them a street), the training " +
		"config ADMITS the country (`country_weights` is a hard filter, so a country absent from it trains on nothing " +
		"— the Norway bug's mechanism), the gazetteer can resolve it (244 countries, a much wider set), and the board " +
		"measures it (rows that are not `status: pass` track rather than gate). Reports the four ways those disagree " +
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
					"shard. Do this after building a new corpus version, not routinely."
			),
		config: z
			.string()
			.optional()
			.describe(
				"Training config path whose `country_weights` decides admission. Defaults to the newest non-smoke one."
			),
	}),
	handler: async (args) => {
		const configPath = (args["config"] as string | undefined) ?? newestConfig(String(repoRootPath()))
		const manifestPath = newestManifest()

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
			casesRoot: `${String(repoRootPath())}/packages/mailwoman/eval-harness/gauntlet/cases`,
			refresh: args["refresh"] === true,
		})

		return projectCoverage(report, args["countries"] as string[] | undefined)
	},
})

/**
 * Project a {@linkcode CoverageReport} into the tool's response shape.
 *
 * Pure and exported so the projection can be TESTED. It builds its result field by field, which means a field the
 * report grows and this function does not name is dropped in silence — and the consumer reads that as the field not
 * existing. The corpus-mismatch guard shipped inert for exactly that reason: the census computed it, fifteen tests
 * passed, and the first live call showed nothing, because this function did not carry it.
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
		n_trained: trained.length,
		n_trained_with_street_data: withStreet.length,
		n_geocodable: report.countries.filter((c) => c.gazetteerPlaces > 0).length,
		rows: shown,
		rendered: shown.map(line),
		...(missing.length ? { requested_but_absent_everywhere: missing } : {}),
		mismatches: report.mismatches,
		summary:
			// A mismatch LEADS. A caller reads the first sentence, and every count after it is about a corpus the run
			// does not read.
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
