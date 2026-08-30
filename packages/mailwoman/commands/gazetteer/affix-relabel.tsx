import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { dirname } from "@mailwoman/platform/path"
import { Box, Text } from "ink"

import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "affix-relabel",
	description: "Export the street-affix relabel lexicon.",
	options: {
		output: { type: "string", description: "Output path" },
	},
} as const satisfies CommandSpec

interface Options {
	output?: string
}

const GazetteerAffixRelabel: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { AbbreviationToDirectional, DirectionalToAbbreviationMap, NAME_PRONE_US_SUFFIXES, US_STREET_SUFFIX_LOOKUP } =
			await import("@mailwoman/codex/us")

		const { repoRootPathBuilder } = await import("@mailwoman/core/utils")

		const output = options.output ?? String(repoRootPathBuilder("data", "gazetteer", "affix-relabel-lexicon-v2.json"))

		// Directionals: every SINGLE-TOKEN surface variant → canonical abbreviation. The codex maps are
		// Maps keyed by the Pub-28 spaced names ("NORTH WEST"); real US streets use the one-word form
		// ("Northwest"), which is what a whitespace-token relabel pass can match — so we emit the abbr
		// ("nw") and the de-spaced name ("northwest"), same surfaces matchLeadingDirectional accepts.
		const directionals: Record<string, string> = {}

		for (const [name, abbr] of DirectionalToAbbreviationMap) {
			directionals[abbr.toLowerCase()] = abbr
			directionals[name.replaceAll(/\s+/g, "").toLowerCase()] = abbr
		}

		for (const [abbr, name] of AbbreviationToDirectional) {
			directionals[abbr.toLowerCase()] = abbr
			directionals[name.replaceAll(/\s+/g, "").toLowerCase()] = abbr
		}

		// Suffixes: the codex lookup already maps every Pub-28 variant (lowercase) → canonical suffix.
		const suffixes: Record<string, string> = {}

		for (const [variant, canonical] of US_STREET_SUFFIX_LOOKUP) {
			suffixes[variant] = canonical
		}

		const lexicon = {
			version: "affix-relabel-v2",
			source: "@mailwoman/codex us/street-directional + us/street-suffix.json (USPS Pub 28 + name-prone curation)",
			directionals,
			suffixes,
			// Licenses the positional split of a >=2-word name whose FINAL word is merely
			// name-prone-shaped when a TRUE suffix follows ('Menlo Park | Road') — the #1569
			// five-whys countermeasure. Loaders reading a v1 artifact (key absent) keep the old
			// blanket rejection.
			name_prone: [...NAME_PRONE_US_SUFFIXES].toSorted(),
		}

		await makeDirectories(dirname(output))
		await writeLocalJSONFile(lexicon, output)

		return [
			`${output}`,
			`${Object.keys(directionals).length} directional variants, ${Object.keys(suffixes).length} suffix variants, ` +
				`${NAME_PRONE_US_SUFFIXES.size} name-prone canonicals`,
		]
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		return (
			<Box flexDirection="column">
				{state.result.map((line, i) => (
					<Text key={i} color={i === 0 ? "green" : undefined}>
						{i === 0 ? "✓ wrote " : "  "}
						{line}
					</Text>
				))}
			</Box>
		)
	}

	return null
}

export default GazetteerAffixRelabel
