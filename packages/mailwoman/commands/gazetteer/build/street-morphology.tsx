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

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "street-morphology",
	description: "Build the sealed street-morphology FST artifact.",
	options: {
		dictionaries: {
			type: "string",
			description: "libpostal dictionaries root (default: core's bundled data/libpostal/dictionaries)",
		},
		locales: {
			type: "string",
			description: "Comma-separated locale subfolders (default: every locale with a street_types.txt)",
		},
		output: {
			type: "string",
			description: "Output path (default: $MAILWOMAN_DATA_ROOT/wof/fst-street-morphology.bin)",
		},
	},
} as const satisfies CommandSpec

interface Options {
	dictionaries?: string
	locales?: string
	output?: string
}

const GazetteerBuildStreetMorphology: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { buildStreetMorphologyArtifact } = await import("#gazetteer/street-morphology")

		const built = await buildStreetMorphologyArtifact({
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
