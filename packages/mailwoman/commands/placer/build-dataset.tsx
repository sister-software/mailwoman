/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman placer build-dataset` — assemble the coarse placer (#244) training dataset: the
 *   stratified per-country corpus/Overture sample (plain run), or `--outliers
 *   <exposure|latin|oa>` to append OTHER-class outlier-exposure rows (WOF non-Latin scripts,
 *   Overture Latin off-map, or OpenAddresses leave-one-family-out). Run the plain build first; the
 *   outlier builders append to its splits.
 */

import {
	type CommandSpec,
	CommandTaskResult,
	type ParsedCommandComponent,
	reportToStderr,
	useCommandTask,
} from "#cli-kit"

export const description = "Assemble the coarse placer (#244) dataset (--outliers appends OTHER exposure)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "build-dataset",
	description,
	options: {
		outliers: {
			type: "string",
			choices: ["exposure", "latin", "oa"],
			description: "Append OTHER outlier-exposure rows",
		},
		data: { type: "string", description: "Dataset dir" },
		"per-country": { type: "number", description: "Rows per country" },
		"per-lang": { type: "number", description: "Names per off-map language" },
		wof: { type: "string", description: "WOF admin SQLite path" },
		overture: { type: "string", description: "Overture release dir" },
		"oa-dir": { type: "string", description: "OpenAddresses root" },
	},
} as const satisfies CommandSpec

interface Options {
	outliers?: "exposure" | "latin" | "oa"
	data?: string
	perCountry?: number
	perLang?: number
	wof?: string
	overture?: string
	oaDir?: string
}

async function run(options: Options): Promise<string> {
	const { buildDataset, buildOutlierExposure, buildOutlierLatin, buildOutlierOA } =
		await import("@mailwoman/core/coarse-placer/tools")

	switch (options.outliers) {
		case "exposure": {
			const res = await buildOutlierExposure(
				{ perLang: options.perLang, wof: options.wof, data: options.data },
				reportToStderr
			)

			return `outliers exposure: ${res.total.toLocaleString()} OTHER rows appended across train/val/test`
		}
		case "latin": {
			const res = await buildOutlierLatin(
				{ perCountry: options.perCountry, overture: options.overture, data: options.data },
				reportToStderr
			)

			return `outliers latin: train +${res.train}, val +${res.val}; test-latin-offmap ${res.test} rows`
		}
		case "oa": {
			const res = await buildOutlierOA(
				{ oaDir: options.oaDir, perCountry: options.perCountry, data: options.data },
				reportToStderr
			)

			return `outliers oa: train +${res.train}, val +${res.val}; test-latin-offmap ${res.test} rows (${res.trainCountries} train / ${res.heldoutCountries} heldout countries)`
		}
		case undefined: {
			const res = await buildDataset({ perCountry: options.perCountry, data: options.data }, reportToStderr)

			return `dataset: train ${res.train.toLocaleString()} / val ${res.val.toLocaleString()} / test ${res.test.toLocaleString()} → ${res.outDir}`
		}
	}
}

const PlacerBuildDataset: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => run(options))

	return <CommandTaskResult state={state} />
}

export default PlacerBuildDataset
