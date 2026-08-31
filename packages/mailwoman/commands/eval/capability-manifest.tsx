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

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"

export const description = "Generate the model-card capability manifest (#718/#719)"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "capability-manifest",
	description,
	options: {
		model: { type: "string", description: "ONNX artifact (default: the production int8 under the data root)" },
		tokenizer: { type: "string", description: "Tokenizer (default: the v0.6.0-a0 tokenizer under the data root)" },
		"model-card": { type: "string", description: "Model card JSON (default neural-weights-en-us/model-card.json)" },
		"anchor-lookup": {
			type: "string",
			description: "Anchor lookup JSON (default: the pilot lookup under the data root)",
		},
		"gazetteer-lexicon": {
			type: "string",
			description: "Gazetteer lexicon JSON (default data/gazetteer/anchor-lexicon-v1.json)",
		},
		write: { type: "boolean", default: false, description: "Patch the capabilities block into the model card" },
	},
} as const satisfies CommandSpec

interface Options {
	model?: string
	tokenizer?: string
	modelCard?: string
	anchorLookup?: string
	gazetteerLexicon?: string
	write: boolean
}

const EvalCapabilityManifest: ParsedCommandComponent<Options> = ({ options }) => {
	const state = useCommandTask(async () => {
		const { generateCapabilityManifest } = await import("#eval-harness/capability-manifest")

		return generateCapabilityManifest(options)
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	// The generator prints the block on stdout and its diagnostics on stderr.
	return null
}

export default EvalCapabilityManifest
