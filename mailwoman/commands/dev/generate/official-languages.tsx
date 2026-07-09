/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman dev generate official-languages` — regenerate `codex/country/official-languages.ts`
 *   from Unicode CLDR supplemental data. Pass `--cldr-dir` to read cldr-territoryInfo.json +
 *   cldr-aliases.json from disk instead of fetching the pinned cldr-core release from jsdelivr.
 */

import { generateOfficialLanguages } from "@mailwoman/codex/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	cldrDir: zod.string().optional().describe("Read cldr-territoryInfo.json + cldr-aliases.json from this directory"),
	cldrVersion: zod.string().default("47.0.0").describe("Pinned cldr-core release fetched from jsdelivr"),
})

export { OptionsSchema as options }

const report = (line: string): void => console.error(line)

const DevGenerateOfficialLanguages: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		generateOfficialLanguages({ cldrDir: options.cldrDir, cldrVersion: options.cldrVersion }, report)
	)

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
