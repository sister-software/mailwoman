/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman eval capability-manifest` — the capability-manifest generator (#718/#719): measures
 *   the per-tier × address-system × tag mask-off/mask-on F1 block the `createScorer` load-time
 *   delta-gate consults. Dry run prints the block; `--write` surgically inserts it into the model
 *   card (refusing if a `capabilities` block already exists).
 */

import { Text } from "ink"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { generateCapabilityManifest } from "../../eval-harness/capability-manifest.ts"

export const description = "Generate the model-card capability manifest (#718/#719)"

const OptionsSchema = zod.object({
	model: zod.string().optional().describe("ONNX artifact (default: the production int8 under the data root)"),
	tokenizer: zod.string().optional().describe("Tokenizer (default: the v0.6.0-a0 tokenizer under the data root)"),
	modelCard: zod.string().optional().describe("Model card JSON (default neural-weights-en-us/model-card.json)"),
	anchorLookup: zod.string().optional().describe("Anchor lookup JSON (default: the pilot lookup under the data root)"),
	gazetteerLexicon: zod
		.string()
		.optional()
		.describe("Gazetteer lexicon JSON (default data/gazetteer/anchor-lexicon-v1.json)"),
	write: zod.boolean().default(false).describe("Patch the capabilities block into the model card"),
})

export { OptionsSchema as options }

const EvalCapabilityManifest: CommandComponent<typeof OptionsSchema> = ({ options }) => {
	const state = useCommandTask(() => generateCapabilityManifest(options))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	// The generator prints the block on stdout and its diagnostics on stderr.
	return null
}

export default EvalCapabilityManifest
