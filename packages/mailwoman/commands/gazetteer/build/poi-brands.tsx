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

import { runFileSync } from "@mailwoman/core/process"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import { DEFAULT_DOMINANCE, DEFAULT_MIN_ROWS } from "#gazetteer-pipeline/poi/defaults"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "poi-brands",
	description: "Build the POI brand lexicon from poi.db.",
	options: {
		db: { type: "string", description: "Built poi.db to read. Default <data-root>/poi/poi.db" },
		out: { type: "string", description: "brands.json output path" },
		"min-rows": { type: "number", description: `Minimum total rows to keep a brand. Default ${DEFAULT_MIN_ROWS}` },
		dominance: { type: "number", description: `Minimum modal-name fraction. Default ${DEFAULT_DOMINANCE}` },
	},
} as const satisfies CommandSpec

interface Options {
	db?: string
	out?: string
	minRows?: number
	dominance?: number
}

const GazetteerBuildPOIBrands: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildBrandTable, defaultBrandTableOutPath, defaultPOIDatabasePath, writeBrandTable } =
			await import("#gazetteer-pipeline/poi/build-brands")

		const dbPath = options.db ?? defaultPOIDatabasePath()
		const out = options.out ?? defaultBrandTableOutPath()
		const minRows = options.minRows ?? DEFAULT_MIN_ROWS
		const dominance = options.dominance ?? DEFAULT_DOMINANCE

		console.error(`▸ reading ${dbPath}`)

		const table = await buildBrandTable({ dbPath, minRows, dominance })

		console.error(`▸ writing ${out}`)

		await writeBrandTable(table, out)
		runFileSync("yarn", ["oxfmt", out])

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
