/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { type CommandSpec, CommandTaskResult, type ParsedCommandComponent, useCommandTask } from "#cli-kit"
import type { PublishHFOptions } from "#release-tools/publish-hf"

/**
 * Native command-line contract consumed by the filesystem command router.
 */
export const spec = {
	name: "hf",
	description: "Stage a model release on Hugging Face.",
	positionals: [{ name: "version", required: true, description: "Release version, e.g. v5.9.0" }],
	options: {
		locale: { type: "string", description: "Locale bucket, e.g. en-us" },
		label: { type: "string", description: "Human-readable release label" },
		description: { type: "string", description: "Release description" },
		model: { type: "string", description: "Candidate int8 ONNX classifier path" },
		tokenizer: { type: "string", description: "SentencePiece tokenizer path" },
		"char-vocab": {
			type: "string",
			description: "Sealed character vocabulary path — stages a character-path family (no tokenizer)",
		},
		"model-card": { type: "string", description: "Model-card JSON path" },
		fst: { type: "string", description: "FST gazetteer path" },
		"model-size": { type: "string", description: "Override the displayed model size" },
		steps: { type: "number", description: "Training steps recorded in releases.json" },
		postcodes: { type: "string", description: "Comma-separated postcode binaries" },
		"pair-indexes": { type: "string", description: "Comma-separated placetype-pair-index binaries" },
		fsts: { type: "string", description: "Comma-separated per-locale FST gazetteers" },
		"gazetteer-lexicon": { type: "string", description: "Gazetteer anchor lexicon JSON" },
		"country-lexicon": { type: "string", description: "Country-surface lexicon JSON" },
		"street-type-lexicon": { type: "string", description: "Street-type evidence lexicon JSON" },
		"locality-surface-lexicon": { type: "string", description: "Locality-surface evidence lexicon JSON" },
		polygons: { type: "string", description: "Crisp-polygon DB" },
		fisher: { type: "string", description: "Comma-separated Fisher consolidation artifacts" },
		"set-default": { type: "boolean", default: false, description: "Set releases.json defaultVersion" },
		"wof-hot": { type: "string", description: "Retired compatibility option; accepted and ignored" },
	},
} as const satisfies CommandSpec

type Options = Omit<PublishHFOptions, "version">

const ReleaseHF: ParsedCommandComponent<Options, [string]> = ({ options, args }) => {
	const state = useCommandTask(async () => {
		const { publishReleaseToHF } = await import("#release-tools/publish-hf")

		return publishReleaseToHF({ ...options, version: args[0] })
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return null
}

export default ReleaseHF
