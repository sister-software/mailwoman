/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman corpus sub-venue-lexicon` — regenerate the sub-venue designator lexicon (#35) from the
 *   fetched sources. Deterministic: same inputs, byte-identical output. Run `oxfmt` over the result
 *   before committing.
 *
 *   ```sh
 *   mailwoman corpus fetch wikidata-subvenue --out-root $MAILWOMAN_DATA_ROOT/sub-venue/sources
 *   mailwoman corpus sub-venue-lexicon \
 *     --wikidata-dir $MAILWOMAN_DATA_ROOT/sub-venue/sources/wikidata-subvenue \
 *     --extracts     "GB=$MAILWOMAN_DATA_ROOT/sub-venue/extracts/great-britain.jsonl,DE=…/germany.jsonl" \
 *     --overture-db  $MAILWOMAN_DATA_ROOT/poi/poi.db \
 *     --out          corpus/data/sub-venue-lexicon.json
 *   ```
 *
 *   `--extracts` takes `REGION=path` pairs because the REGION is the axis every curation decision is
 *   taken on and no extract filename carries it reliably (`ile-de-france` is FR, `great-britain` is
 *   GB). A bare path is accepted and lands region `""`, which means the surfaces it produces can never
 *   be promoted — that is the correct failure, not a convenience.
 */

import { Text } from "ink"
import { type CommandSpec, type ParsedCommandComponent, useCommandTask } from "mailwoman/cli-kit"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "sub-venue-lexicon",
	description: "Regenerate the sub-venue designator lexicon.",
	options: {
		"wikidata-dir": { type: "string", description: "Wikidata fetch output" },
		extracts: { type: "string", description: "Comma-separated REGION=path extract pairs" },
		"overture-db": { type: "string", description: "Path to poi.db" },
		out: { type: "string", default: "corpus/data/sub-venue-lexicon.json", description: "Destination" },
	},
} as const satisfies CommandSpec

interface Options {
	wikidataDir?: string
	extracts?: string
	overtureDB?: string
	out: string
}

/**
 * Split `GB=/a.jsonl,DE=/b.jsonl` into extract inputs. A bare path keeps region `""`.
 */
function parseExtracts(extractSpec: string | undefined): Array<{ path: string; region: string }> {
	if (!extractSpec) return []

	return extractSpec
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const split = entry.indexOf("=")

			return split === -1
				? { path: entry, region: "" }
				: { region: entry.slice(0, split).trim(), path: entry.slice(split + 1).trim() }
		})
}

const CorpusSubVenueLexicon: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { generateSubVenueLexicon, readOvertureLayerVintage, readOvertureSubVenues } =
			await import("@mailwoman/corpus/tools")

		const overtureRows = options.overtureDB
			? await readOvertureSubVenues({ databasePath: options.overtureDB })
			: undefined

		return generateSubVenueLexicon({
			wikidataDir: options.wikidataDir,
			extracts: parseExtracts(options.extracts),
			overtureRows,
			overtureVintage: options.overtureDB ? await readOvertureLayerVintage(options.overtureDB) : undefined,
			outPath: options.out,
		})
	})

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { designators, modifiers, surfaces, identifierShapes, promotions } = state.result

		return (
			<Text color="green">
				{options.out}: {designators.length} designators, {modifiers.length} modifiers, {surfaces.length} surfaces (
				{surfaces.filter((surface) => surface.curated).length} curated), {identifierShapes.length} identifier shapes,{" "}
				{promotions.length} curation decisions
			</Text>
		)
	}

	return null
}

export default CorpusSubVenueLexicon
