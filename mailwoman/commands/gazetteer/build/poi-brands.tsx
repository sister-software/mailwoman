/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build poi-brands` — the POI brand lexicon builder, part 1 of 2 (part 2 wires
 *   `lookupPOIBrand` into the runtime pipeline; no pipeline wiring here). Thin wiring only: the read +
 *   aggregate + write logic lives in `gazetteer-pipeline/poi/build-brands.ts`, mirroring `build/poi.tsx`'s
 *   thin-command style. Reads a BUILT `poi.db` READ-ONLY — never writes one.
 *
 *   `writeBrandTable`'s plain `JSON.stringify` doesn't collapse short primitive arrays onto one line the
 *   way `oxfmt` does (e.g. `"aliases": ["Foo"]` vs a 3-line array) — the process-y bit (shelling out, like
 *   `poi.tsx`'s own `git rev-parse`) belongs at the command layer, not in the pure/testable builder. Runs
 *   `oxfmt` on the output here so the emitted file is commit-ready without a manual format pass.
 */

import { execFileSync } from "node:child_process"

import { Box, Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"
import {
	buildBrandTable,
	DEFAULT_DOMINANCE,
	DEFAULT_MIN_ROWS,
	defaultBrandTableOutPath,
	defaultPOIDatabasePath,
	writeBrandTable,
} from "../../../gazetteer-pipeline/poi/build-brands.ts"

const OptionsSchema = zod.object({
	db: zod.string().optional().describe("Built poi.db to read. Default <data-root>/poi/poi.db"),
	out: zod.string().optional().describe("brands.json output path. Default poi-taxonomy/data/brands.json"),
	minRows: zod.string().optional().describe(`Minimum total rows to keep a brand. Default ${DEFAULT_MIN_ROWS}`),
	dominance: zod
		.string()
		.optional()
		.describe(
			`Minimum fraction of a QID's total rows its modal name must cover to qualify — below this the QID is ` +
				`dropped entirely (systematic mistagging). Default ${DEFAULT_DOMINANCE}`
		),
})

export { OptionsSchema as options }

const GazetteerBuildPOIBrands: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const dbPath = options.db ?? defaultPOIDatabasePath()
		const out = options.out ?? defaultBrandTableOutPath()
		const minRows = options.minRows ? Number.parseInt(options.minRows, 10) : DEFAULT_MIN_ROWS
		const dominance = options.dominance ? Number.parseFloat(options.dominance) : DEFAULT_DOMINANCE

		console.error(`▸ reading ${dbPath}`)
		const table = await buildBrandTable({ dbPath, minRows, dominance })

		console.error(`▸ writing ${out}`)
		writeBrandTable(table, out)
		execFileSync("yarn", ["oxfmt", out])

		const top5 = table.brands
			.slice(0, 5)
			.map((b, i) => `  ${i + 1}. ${b.name} (${b.wikidata}) — ${b.rows.toLocaleString()} rows`)

		return [
			`brands.json: ${out} (${table.brands.length.toLocaleString()} brands, min-rows=${minRows}, dominance=${dominance})`,
			`source: ${table.sourceLayer.name} ${table.sourceLayer.version} (vintage ${table.sourceLayer.sourceVintage})`,
			"top 5 by rows:",
			...top5,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null // progress streams to stderr until the summary lands
}

export default GazetteerBuildPOIBrands
