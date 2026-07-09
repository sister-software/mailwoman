/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman gazetteer affix-relabel` — export the codex US street-affix vocab (directionals +
 *   Pub-28 street suffixes) as a JSON lexicon for the Python training loader's affix-split relabel
 *   pass (#511). Same one-source-of-truth pattern as `gazetteer anchor-lexicon`: the TS codex
 *   matchers stay canonical; Python consumes a dumb variant→canonical map so the relabel pass
 *   agrees with the affix shard builder (which calls the codex matchers directly) by construction.
 *
 *   Output: data/gazetteer/affix-relabel-lexicon-v1.json
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

import { AbbreviationToDirectional, DirectionalToAbbreviationMap, US_STREET_SUFFIX_LOOKUP } from "@mailwoman/codex/us"
import { repoRootPathBuilder } from "@mailwoman/core/utils"
import { Box, Text } from "ink"
import { useEffect, useState } from "react"
import zod from "zod"

import type { CommandComponent } from "../../sdk/cli.ts"

const OptionsSchema = zod.object({
	output: zod.string().optional().describe("Output path. Default <repo>/data/gazetteer/affix-relabel-lexicon-v1.json"),
})

export { OptionsSchema as options }

const GazetteerAffixRelabel: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const [error, setError] = useState<string>()
	const [summary, setSummary] = useState<string[]>()

	useEffect(() => {
		void (async () => {
			try {
				const output =
					options.output ?? String(repoRootPathBuilder("data", "gazetteer", "affix-relabel-lexicon-v1.json"))

				// Directionals: every SINGLE-TOKEN surface variant → canonical abbreviation. The codex maps are
				// Maps keyed by the Pub-28 spaced names ("NORTH WEST"); real US streets use the one-word form
				// ("Northwest"), which is what a whitespace-token relabel pass can match — so we emit the abbr
				// ("nw") and the de-spaced name ("northwest"), same surfaces matchLeadingDirectional accepts.
				const directionals: Record<string, string> = {}

				for (const [name, abbr] of DirectionalToAbbreviationMap) {
					directionals[abbr.toLowerCase()] = abbr
					directionals[name.replace(/\s+/g, "").toLowerCase()] = abbr
				}

				for (const [abbr, name] of AbbreviationToDirectional) {
					directionals[abbr.toLowerCase()] = abbr
					directionals[name.replace(/\s+/g, "").toLowerCase()] = abbr
				}

				// Suffixes: the codex lookup already maps every Pub-28 variant (lowercase) → canonical suffix.
				const suffixes: Record<string, string> = {}

				for (const [variant, canonical] of US_STREET_SUFFIX_LOOKUP) {
					suffixes[variant] = canonical
				}

				const lexicon = {
					version: "affix-relabel-v1",
					source: "@mailwoman/codex us/street-directional + us/street-suffix (USPS Pub 28)",
					directionals,
					suffixes,
				}

				mkdirSync(dirname(output), { recursive: true })
				writeFileSync(output, JSON.stringify(lexicon, null, "\t") + "\n")

				setSummary([
					`${output}`,
					`${Object.keys(directionals).length} directional variants, ${Object.keys(suffixes).length} suffix variants`,
				])
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e))
			}
		})()
	}, [options])

	useEffect(() => {
		if (summary || error) {
			setImmediate(() => process.exit(error ? 1 : 0))
		}
	}, [summary, error])

	if (error) return <Text color="red">✗ {error}</Text>

	if (summary) {
		return (
			<Box flexDirection="column">
				{summary.map((line, i) => (
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
