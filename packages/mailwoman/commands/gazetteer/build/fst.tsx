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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "fst",
	description: "Build curated per-locale decode-bias FST gazetteers.",
	options: {
		locales: { type: "string", description: "Comma-separated locales (default: all shipped FST locales)" },
		db: { type: "string", description: "WOF admin DB (default: $MAILWOMAN_DATA_ROOT/wof/admin-global-priority.db)" },
		output: { type: "string", description: "Output dir (default: $MAILWOMAN_DATA_ROOT/wof/fst-per-locale-curated)" },
		uncurated: { type: "boolean", default: false, description: "A/B control build: same DB, no curation" },
	},
} as const satisfies CommandSpec

interface Options {
	locales?: string
	db?: string
	output?: string
	uncurated: boolean
}

const GazetteerBuildFST: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocaleFSTs } = await import("#gazetteer/fst")

		const built = await buildLocaleFSTs({
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
