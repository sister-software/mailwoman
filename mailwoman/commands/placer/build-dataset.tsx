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
	buildDataset,
	buildOutlierExposure,
	buildOutlierLatin,
	buildOutlierOA,
} from "@mailwoman/core/coarse-placer/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

export const description = "Assemble the coarse placer (#244) dataset (--outliers appends OTHER exposure)"

const OptionsSchema = zod.object({
	outliers: zod
		.enum(["exposure", "latin", "oa"])
		.optional()
		.describe("Append OTHER outlier-exposure rows instead of the plain build (exposure, latin, oa)"),
	data: zod.string().optional().describe("Dataset dir (default <repo>/data/coarse-placer)"),
	perCountry: zod.number().optional().describe("Rows per country (default 50000 plain; 6000 for --outliers latin/oa)"),
	perLang: zod.number().optional().describe("exposure: names per off-map language (default 2500)"),
	wof: zod
		.string()
		.optional()
		.describe("exposure: WOF admin SQLite path (default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)"),
	overture: zod
		.string()
		.optional()
		.describe("latin: Overture release dir (default $MAILWOMAN_DATA_ROOT/overture/2026-05-20.0)"),
	oaDir: zod
		.string()
		.optional()
		.describe("oa: extracted OpenAddresses root (default $MAILWOMAN_DATA_ROOT/openaddresses/extracted)"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>

const report = (line: string): void => console.error(line)

async function run(options: Options): Promise<string> {
	switch (options.outliers) {
		case "exposure": {
			const res = await buildOutlierExposure({ perLang: options.perLang, wof: options.wof, data: options.data }, report)

			return `outliers exposure: ${res.total.toLocaleString()} OTHER rows appended across train/val/test`
		}
		case "latin": {
			const res = await buildOutlierLatin(
				{ perCountry: options.perCountry, overture: options.overture, data: options.data },
				report
			)

			return `outliers latin: train +${res.train}, val +${res.val}; test-latin-offmap ${res.test} rows`
		}
		case "oa": {
			const res = await buildOutlierOA(
				{ oaDir: options.oaDir, perCountry: options.perCountry, data: options.data },
				report
			)

			return `outliers oa: train +${res.train}, val +${res.val}; test-latin-offmap ${res.test} rows (${res.trainCountries} train / ${res.heldoutCountries} heldout countries)`
		}
		case undefined: {
			const res = await buildDataset({ perCountry: options.perCountry, data: options.data }, report)

			return `dataset: train ${res.train.toLocaleString()} / val ${res.val.toLocaleString()} / test ${res.test.toLocaleString()} → ${res.outDir}`
		}
	}
}

const PlacerBuildDataset: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => run(options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") return <Text color="green">{state.result}</Text>

	return null
}

export default PlacerBuildDataset
