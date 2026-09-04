/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Shared plumbing for the baseline-vs-candidate probes: the argument block with its
 *   required-flag check, the punctuation-dropping fold, the word-boundary containment test, the
 *   paired classifier load, and the golden-row loader. Each probe keeps its own scoring.
 */

import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { escapeRegExp } from "@mailwoman/core/strings/regexp"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { JSONSpliterator } from "spliterator"

/**
 * One golden-set row: the raw address and its gold components.
 */
export interface GoldenRow {
	raw: string
	components: Record<string, string>
}

export interface TwoModelArgs {
	baseline: string
	candidate: string
	tokenizer: string
	"model-card"?: string
	golden: string
	n: number
}

const DEFAULT_GOLDEN = "data/eval/golden/v0.1.2/dev/us.jsonl"

function requiredFlag(name: string, value: string | undefined): string {
	if (!value) throw new Error(`--${name} required`)

	return value
}

/**
 * The probes' shared argument block: `--baseline` / `--candidate` / `--tokenizer` (required), `--model-card`,
 * `--golden`, and `--n` (whose default is per probe).
 */
export function parseTwoModelArgs(nDefault: string): TwoModelArgs {
	const { values: args } = parseArguments({
		options: {
			baseline: { type: "string" },
			candidate: { type: "string" },
			tokenizer: { type: "string" },
			"model-card": { type: "string" },
			golden: { type: "string", default: DEFAULT_GOLDEN },
			n: { type: "string", default: nDefault },
		},
	})

	const modelCard = args["model-card"]

	return {
		baseline: requiredFlag("baseline", args.baseline),
		candidate: requiredFlag("candidate", args.candidate),
		tokenizer: requiredFlag("tokenizer", args.tokenizer),
		...(modelCard ? { "model-card": modelCard } : {}),
		golden: args.golden ?? DEFAULT_GOLDEN,
		n: Number(args.n ?? nDefault),
	}
}

/**
 * The probes' fold: lower-case, periods and commas dropped, whitespace runs collapsed, ends trimmed.
 */
export const norm = (s?: string): string =>
	(s ?? "").toLowerCase().replaceAll(/[.,]/g, "").replaceAll(/\s+/g, " ").trim()

/**
 * True when `needle` appears in `hay` on word boundaries — `"Ave"` in `"Elm Ave"` but never in `"Avenue"`.
 */
export const wordIncludes = (hay: string, needle: string): boolean =>
	needle.length > 0 && new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(hay)

/**
 * Load the baseline + candidate classifiers with one shared tokenizer / model-card wiring.
 */
export function loadClassifierPair(args: TwoModelArgs): Promise<[NeuralAddressClassifier, NeuralAddressClassifier]> {
	const load = (modelPath: string) =>
		NeuralAddressClassifier.loadFromWeights({
			locale: "en-US",
			modelPath,
			tokenizerPath: args.tokenizer,
			modelCardPath: args["model-card"],
		})

	return Promise.all([load(args.baseline), load(args.candidate)])
}

/**
 * The first `n` rows of a golden JSONL.
 */
export async function loadGoldenRows(path: string, n: number): Promise<GoldenRow[]> {
	return (await Array.fromAsync(JSONSpliterator.fromAsync<GoldenRow>(path))).slice(0, n)
}
