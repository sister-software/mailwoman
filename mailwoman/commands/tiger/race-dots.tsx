/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman tiger race-dots` — race-by-dot-density NDJSON builder (the Cooper Center "Racial Dot
 *   Map" recipe) from a TIGER DB built by `tiger fetch` + `tiger redistricting`. Pipe the output
 *   through tippecanoe, then render with `tiger race-dots-map`.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	db: zod
		.string()
		.optional()
		.describe("TIGER SQLite DB (tabblock20 ⋈ pl_block; default $MAILWOMAN_DATA_ROOT/tiger/tiger-oc.db)"),
	out: zod
		.string()
		.default("/tmp/race-dots.ndjson")
		.describe("Output NDJSON path (one GeoJSON Point Feature per line, tippecanoe-ready)"),
	per: zod.number().default(10).describe("People represented by one dot"),
	layer: zod.string().default("dots").describe("Tippecanoe layer name"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const TIGERRaceDots: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		// Optional `@mailwoman/tiger` (operator census tooling) — lazy-imported so a geocoding-only
		// install of the CLI degrades to a friendly message instead of crashing (see `tiger fetch`).
		let raceDots: typeof import("@mailwoman/tiger/tools").raceDots

		try {
			;({ raceDots } = await import("@mailwoman/tiger/tools"))
		} catch {
			throw new Error(
				"`tiger race-dots` needs the optional @mailwoman/tiger package — install it with: npm install @mailwoman/tiger"
			)
		}

		return raceDots({ db: options.db, out: options.out, per: options.per, layer: options.layer }, report)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { dots, blocks, skipped, outPath } = state.result

		return (
			<Text color="green">
				{dots.toLocaleString()} dots from {blocks.toLocaleString()} blocks ({skipped} skipped) → {outPath}
			</Text>
		)
	}

	return null
}

export default TIGERRaceDots
