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

import { generateSubVenueLexicon, readOvertureLayerVintage, readOvertureSubVenues } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import { type CommandComponent, useCommandTask } from "mailwoman/cli-kit"
import zod from "zod"

const OptionsSchema = zod.object({
	wikidataDir: zod.string().optional().describe("Directory holding the wikidata-subvenue fetch output"),
	extracts: zod
		.string()
		.optional()
		.describe("Comma-separated REGION=path pairs of sub-venue extract JSONLs (GB=…/great-britain.jsonl)"),
	overtureDb: zod.string().optional().describe("Path to poi.db, for the Overture Places sub-venue slice"),
	out: zod.string().default("corpus/data/sub-venue-lexicon.json").describe("Destination for the generated table"),
})

export { OptionsSchema as options }

/**
 * Split `GB=/a.jsonl,DE=/b.jsonl` into extract inputs. A bare path keeps region `""`.
 */
function parseExtracts(spec: string | undefined): Array<{ path: string; region: string }> {
	if (!spec) return []

	return spec
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

const CorpusSubVenueLexicon: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(async () => {
		const overtureRows = options.overtureDb
			? await readOvertureSubVenues({ databasePath: options.overtureDb })
			: undefined

		return generateSubVenueLexicon({
			wikidataDir: options.wikidataDir,
			extracts: parseExtracts(options.extracts),
			overtureRows,
			overtureVintage: options.overtureDb ? await readOvertureLayerVintage(options.overtureDb) : undefined,
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
