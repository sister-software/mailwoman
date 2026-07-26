/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build fst` — per-locale decode-bias FST gazetteers (`fst-<locale>.bin`,
 *   #1318) with build-time degenerate-surface curation. Artifacts land in a staging dir BESIDE the
 *   shipped `fst-per-locale/` (never overwriting); the swap is operator-gated after the battery. See
 *   `mailwoman/gazetteer-pipeline/fst.ts` for the curation policy.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	locales: zod.string().optional().describe("Comma-separated locales (default: all shipped FST locales)"),
	db: zod.string().optional().describe("WOF admin DB (default: $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)"),
	output: zod.string().optional().describe("Output dir (default: $MAILWOMAN_DATA_ROOT/wof/fst-per-locale-curated)"),
	uncurated: zod.boolean().default(false).describe("A/B control build: same DB, no curation"),
})

export { OptionsSchema as options }

const GazetteerBuildFST: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocaleFSTs } = await import("../../../gazetteer-pipeline/fst.ts")
		const built = buildLocaleFSTs({
			locales: options.locales?.split(",").map((s) => s.trim()),
			dbPath: options.db,
			outputDir: options.output,
			uncurated: options.uncurated,
			onProgress: (line) => console.error(line),
		})

		return built.map(
			(b) =>
				`fst-${b.locale} → ${b.path} (${(b.bytes / 1e6).toFixed(1)} MB, ${b.nameInsertions} insertions, ${b.excludedInsertions} excluded)`
		)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<>
				{state.result.map((line, i) => (
					<Text key={i} color="green">
						✓ {line}
					</Text>
				))}
			</>
		)
	}

	return null
}

export default GazetteerBuildFST
