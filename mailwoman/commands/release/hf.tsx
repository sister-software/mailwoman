/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman release hf` — publish a model release to the HF bucket + the standalone HF model
 *   repo, verifying every artifact is reachable before releases.json is updated. The operator-side
 *   HF staging step of RELEASING.md (runs on the operator's host with HF_TOKEN; CI's publish.yml
 *   fetches what this stages).
 */

import { Text } from "ink"
import { argument } from "pastel"
import zod from "zod"

import { type CommandComponent, useCommandTask } from "../../cli-kit/index.ts"
import { publishReleaseToHF } from "../../release-tools/publish-hf.ts"

export const args = zod.array(
	zod.string().describe(
		argument({
			name: "version",
			description: "Release version, e.g. v5.9.0 (positional — `--version` is the CLI's own version flag)",
		})
	)
)

const OptionsSchema = zod.object({
	locale: zod.string().optional().describe("Locale bucket, e.g. en-us"),
	label: zod.string().optional().describe("Human-readable release label"),
	description: zod.string().optional().describe("Release description"),
	model: zod.string().optional().describe("Candidate int8 ONNX classifier path"),
	tokenizer: zod.string().optional().describe("SentencePiece tokenizer path"),
	modelCard: zod.string().optional().describe("Model-card JSON path"),
	fst: zod.string().optional().describe("FST gazetteer path (remote name adapts to the locale)"),
	modelSize: zod.string().optional().describe("Override the displayed model size (default: derived from --model)"),
	steps: zod.number().optional().describe("Training steps recorded in releases.json (default 100000)"),
	postcodes: zod.string().optional().describe("Comma-separated postcode soft-feed binaries (postcode-us.bin,…)"),
	gazetteerLexicon: zod
		.string()
		.optional()
		.describe("Gazetteer anchor lexicon JSON (uploaded as anchor-lexicon-v1.json)"),
	countryLexicon: zod
		.string()
		.optional()
		.describe("Country-surface lexicon JSON (#1104; uploaded as country-surface-lexicon-v1.json)"),
	polygons: zod.string().optional().describe("Crisp-polygon DB (uploaded as wof-polygons.db)"),
	setDefault: zod.boolean().default(false).describe("Set this version as releases.json defaultVersion"),
	wofHot: zod.string().optional().describe("RETIRED 2026-06-20 (slim wof-hot.db) — accepted and ignored"),
})

export { OptionsSchema as options }

const ReleaseHF: CommandComponent<typeof OptionsSchema, typeof args> = ({ options, args }) => {
	const state = useCommandTask(() => publishReleaseToHF({ ...options, version: args[0] }))

	if (state.status === "error") return <Text color="red">✗ {state.message}</Text>

	return null
}

export default ReleaseHF
