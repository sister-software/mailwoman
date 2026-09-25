/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { Text } from "ink"

import { type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"

/**
 * Command specification for `gazetteer build fst`, which builds curated per-locale FST gazetteers.
 *
 * The output directory defaults to a sibling of the shipped `fst-per-locale/` directory,
 * so a build never overwrites the shipped files.
 */
export const spec = {
	name: "fst",
	description: "Build curated per-locale decode-bias FST gazetteers.",
	options: {
		locales: { type: "string", description: "Comma-separated locales (default: all shipped FST locales)" },
		db: { type: "string", description: "WOF admin DB (default: $MAILWOMAN_DATA_ROOT/db/wof/admin-global-priority.db)" },
		out: {
			type: "string",
			description: "Output dir (default: $MAILWOMAN_DATA_ROOT/db/wof/fst-per-locale-curated)",
			deprecatedName: "output",
		},
		uncurated: {
			type: "boolean",
			default: false,
			description: "Build from the same DB without curation, as an A/B control",
		},
	},
} as const satisfies CommandSpec

const GazetteerBuildFST: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildLocaleFSTs } = await import("#gazetteer/fst")

		const built = await buildLocaleFSTs({
			locales: options.locales === undefined ? undefined : extractDelimited(options.locales),
			dbPath: options.db,
			outputDir: options.out,
			uncurated: options.uncurated,
			onProgress: (line) => console.error(line),
		})

		return built.map(
			(b) =>
				`fst-${b.locale} → ${b.path} (${ByteFormatter.formatIEC(b.bytes)}, ${b.nameInsertions} insertions, ${b.excludedInsertions} excluded)`
		)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

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
