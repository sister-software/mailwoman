/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer build street-morphology` — the sealed street-morphology FST artifact
 *   (`fst-street-morphology.bin`), the #1315 street-context gate's signal source serialized once at
 *   build time instead of rebuilt from the libpostal dictionaries per process (and never in the
 *   browser). Lands at `$MAILWOMAN_DATA_ROOT/wof/` by default — beside, never inside, the
 *   per-locale FST dir. See `mailwoman/gazetteer-pipeline/street-morphology.ts` for the rationale.
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	dictionaries: zod
		.string()
		.optional()
		.describe("libpostal dictionaries root (default: core's bundled data/libpostal/dictionaries)"),
	locales: zod
		.string()
		.optional()
		.describe("Comma-separated locale subfolders (default: every locale with a street_types.txt)"),
	output: zod.string().optional().describe("Output path (default: $MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin)"),
})

export { OptionsSchema as options }

const GazetteerBuildStreetMorphology: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildStreetMorphologyArtifact } = await import("../../../gazetteer-pipeline/street-morphology.ts")

		const built = buildStreetMorphologyArtifact({
			dictionariesDir: options.dictionaries,
			locales: options.locales?.split(",").map((s) => s.trim()),
			output: options.output,
			onProgress: (line) => console.error(line),
		})

		return `${built.path} (${(built.bytes / 1e3).toFixed(0)} kB, ${built.canonicalCount} canonicals, ${built.variantCount} variants, ${built.localeCount} locales)`
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return <Text color="green">✓ {state.result}</Text>
	}

	return null
}

export default GazetteerBuildStreetMorphology
