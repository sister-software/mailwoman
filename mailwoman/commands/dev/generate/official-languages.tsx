/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate official-languages` — regenerate `codex/country/official-languages.ts`
 *   from Unicode CLDR supplemental data. Pass `--cldr-dir` to read cldr-territoryInfo.json +
 *   cldr-aliases.json from disk instead of fetching the pinned cldr-core release from jsdelivr.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "official-languages",
	description: "Generate the official-language table from CLDR.",
	options: {
		"cldr-dir": {
			type: "string",
			description: "Read cldr-territoryInfo.json + cldr-aliases.json from this directory",
		},
		"cldr-version": {
			type: "string",
			default: "47.0.0",
			description: "Pinned cldr-core release fetched from jsdelivr",
		},
	},
} as const satisfies CommandSpec

interface Options {
	cldrDir?: string
	cldrVersion: string
}

const report = (line: string): void => console.error(line)

const DevGenerateOfficialLanguages: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { generateOfficialLanguages } = await import("@mailwoman/codex/tools")

		return generateOfficialLanguages({ cldrDir: options.cldrDir, cldrVersion: options.cldrVersion }, report)
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Text color="green">
				✓ wrote {state.result.outPath}: {state.result.territories} territories (CLDR {state.result.cldrVersion})
			</Text>
		)
	}

	return null
}

export default DevGenerateOfficialLanguages
