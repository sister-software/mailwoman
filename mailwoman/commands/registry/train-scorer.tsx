/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman registry train-scorer <variant>` — train + emit a committed learned-scorer model:
 *   `gbt` (the production dedup GBT, #603), `cross-gbt` (the NPI-anchored cross-source link scorer,
 *   #655 option 2), or `org-cross-gbt` (the CCN-anchored org-level cross-source scorer). Needs the
 *   record-matcher source files, weights, and WOF/shard data locally — operator-run, not CI.
 */

import { trainCrossSourceGBT, trainDedupGBT, trainOrgCrossSourceGBT } from "@mailwoman/registry/tools"
import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { evalGeocoderFactory } from "./run.tsx"

export const args = zod.tuple([
	zod.enum(["gbt", "cross-gbt", "org-cross-gbt"]).describe(
		argument({
			name: "variant",
			description: "Model variant (gbt, cross-gbt, org-cross-gbt)",
		})
	),
])

const OptionsSchema = zod.object({
	sources: zod
		.string()
		.optional()
		.describe("Record-matcher sources dir (default $MAILWOMAN_DATA_ROOT/record-matcher/sources)"),
	state: zod.string().optional().describe("gbt/cross-gbt: state filter (default TX)"),
	npis: zod.number().optional().describe("gbt/cross-gbt: NPIs sampled (default 3000 gbt / 2000 cross-gbt)"),
	cap: zod.number().optional().describe("org-cross-gbt: Care Compare facilities sampled (default 6000)"),
	cost: zod.number().optional().describe("gbt: negative-class up-weight (#625 cost-sensitive; 1 = symmetric default)"),
	precisionBar: zod
		.number()
		.optional()
		.describe("cross-gbt/org-cross-gbt: held-out pairwise precision bar (#655 rule; default 0.95)"),
	out: zod.string().optional().describe("Output TS module path (each variant has a registry/models default)"),
	locale: zod.string().default("en-US").describe("Weights locale (loaded by the geocoder + stamped in the meta)"),
	date: zod.string().optional().describe("Training date stamped into the meta (for reproducible commits)"),
	wof: zod
		.string()
		.optional()
		.describe("WOF admin SQLite path (default $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)"),
	dataRoot: zod.string().optional().describe("Per-state shard root (default $MAILWOMAN_DATA_ROOT)"),
})

export { OptionsSchema as options }

type Options = zod.infer<typeof OptionsSchema>
type Variant = zod.infer<typeof args>[0]

const report = (line: string): void => console.error(line)

function runVariant(variant: Variant, options: Options): Promise<{ out: string; pairs: number }> {
	const createGeocoder = evalGeocoderFactory({
		wof: options.wof,
		dataRoot: options.dataRoot,
		locale: options.locale,
	})
	const base = { createGeocoder, sources: options.sources, out: options.out, locale: options.locale }

	switch (variant) {
		case "gbt":
			return trainDedupGBT(
				{ ...base, state: options.state, npis: options.npis, cost: options.cost, date: options.date },
				report
			)
		case "cross-gbt":
			return trainCrossSourceGBT(
				{
					...base,
					state: options.state,
					npis: options.npis,
					precisionBar: options.precisionBar,
					date: options.date,
				},
				report
			)
		case "org-cross-gbt":
			return trainOrgCrossSourceGBT(
				{ ...base, cap: options.cap, precisionBar: options.precisionBar, date: options.date },
				report
			)
	}
}

const RegistryTrainScorer: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(() => runVariant(args[0], options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				train-scorer {args[0]}: {state.result.pairs} pairs → {state.result.out}
			</Text>
		)
	}

	return null
}

export default RegistryTrainScorer
