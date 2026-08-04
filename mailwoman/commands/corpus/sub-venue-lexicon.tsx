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
 *     --osm-jsonl    $MAILWOMAN_DATA_ROOT/sub-venue/extracts/great-britain.jsonl \
 *     --out          corpus/data/sub-venue-lexicon.json
 *   ```
 */

import { generateSubVenueLexicon } from "@mailwoman/corpus/tools"
import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"

const OptionsSchema = zod.object({
	wikidataDir: zod.string().optional().describe("Directory holding the wikidata-subvenue fetch output"),
	osmJsonl: zod.string().optional().describe("JSONL of @mailwoman/osm/sdk extractOSMSubVenues rows"),
	out: zod.string().default("corpus/data/sub-venue-lexicon.json").describe("Destination for the generated table"),
})

export { OptionsSchema as options }

const CorpusSubVenueLexicon: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() =>
		Promise.resolve(
			generateSubVenueLexicon({
				wikidataDir: options.wikidataDir,
				osmJSONL: options.osmJsonl,
				outPath: options.out,
			})
		)
	)

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	if (state.status === "done") {
		const { designators, modifiers, surfaces, identifierShapes } = state.result

		return (
			<Text color="green">
				{options.out}: {designators.length} designators, {modifiers.length} modifiers, {surfaces.length} surfaces,{" "}
				{identifierShapes.length} identifier shapes
			</Text>
		)
	}

	return null
}

export default CorpusSubVenueLexicon
