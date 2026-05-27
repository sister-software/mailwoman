/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Weight-package resolution.
 *
 *   The `@mailwoman/neural-weights-<locale>` packages ship the `model.onnx` + `tokenizer.model` files
 *   declared in their `files` array. At install time npm bundles those files alongside the
 *   package.json; at runtime we locate them by resolving the package.json then walking sideways.
 *
 *   Local development gotcha: the weights packages in the monorepo carry only metadata (package.json
 *
 *   - README.md + model-card.json). The actual binary files are produced by Phase 2 training and copied
 *       in at publish time. To run the neural classifier locally without publishing, either:
 *
 *   1. Pass explicit `modelPath` + `tokenizerPath` to `loadFromWeights`, or
 *   2. Symlink the dev model files into the weights package directory — see
 *        `scripts/link-dev-weights.sh` in each weights package.
 *
 *   The resolver checks for both files and throws a single actionable error when neither is findable,
 *   naming all the paths it tried.
 */

import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

const req = createRequire(import.meta.url)

export interface ResolveWeightsOpts {
	/** BCP-47-ish locale tag, e.g. "en-us" or "fr-fr". Used to pick the weights package. */
	locale?: string
	/** Explicit model.onnx path; takes precedence over package auto-resolve. */
	modelPath?: string
	/** Explicit tokenizer.model path; takes precedence over package auto-resolve. */
	tokenizerPath?: string
}

export interface ResolvedWeights {
	modelPath: string
	tokenizerPath: string
	/**
	 * Path to `model-card.json` alongside the resolved model. `undefined` when the caller passed
	 * explicit paths or when the package directory has no card on disk. Read by `loadFromWeights` to
	 * thread the trained label vocabulary into the classifier — see {@link readLabelsFromModelCard}.
	 */
	modelCardPath?: string
	/**
	 * Path to `crf-transitions.json` alongside the resolved model. `undefined` when the file
	 * doesn't exist (pre-v0.6.0 bundles or CE-only training).
	 */
	crfTransitionsPath?: string
	/** "explicit" if both paths came from opts; "package:<name>" if resolved via require.resolve. */
	source: string
}

export function resolveWeights(opts: ResolveWeightsOpts): ResolvedWeights {
	const tried: string[] = []

	if (opts.modelPath && opts.tokenizerPath) {
		if (!existsSync(opts.modelPath)) throw new Error(`Explicit modelPath does not exist: ${opts.modelPath}`)
		if (!existsSync(opts.tokenizerPath)) throw new Error(`Explicit tokenizerPath does not exist: ${opts.tokenizerPath}`)
		return { modelPath: opts.modelPath, tokenizerPath: opts.tokenizerPath, source: "explicit" }
	}

	// Package names follow the all-lowercase BCP-47 convention (`neural-weights-en-us`,
	// `neural-weights-fr-fr`). The CLI's locale validation accepts canonical `en-US` / `fr-FR`
	// casing, so we normalize here rather than at the callsite.
	const locale = (opts.locale ?? "en-us").toLowerCase()
	const packageName = `@mailwoman/neural-weights-${locale}`
	let packageDir: string
	try {
		const pkgJsonPath = req.resolve(`${packageName}/package.json`)
		packageDir = dirname(pkgJsonPath)
	} catch {
		throw new Error(
			`Could not resolve ${packageName}. Install it via: npm install ${packageName}\n` +
				`Or pass --model + --tokenizer with explicit paths.`
		)
	}

	const modelPath = opts.modelPath ?? resolve(packageDir, "model.onnx")
	const tokenizerPath = opts.tokenizerPath ?? resolve(packageDir, "tokenizer.model")
	tried.push(modelPath, tokenizerPath)

	if (!existsSync(modelPath) || !existsSync(tokenizerPath)) {
		throw new Error(
			`Weights package ${packageName} resolved at ${packageDir} but is missing model files.\n` +
				`Tried:\n  ${tried.join("\n  ")}\n` +
				`Run \`scripts/link-dev-weights.sh\` inside the package to symlink dev weights, ` +
				`or pass --model + --tokenizer with explicit paths.`
		)
	}

	const modelCardCandidate = resolve(packageDir, "model-card.json")
	const modelCardPath = existsSync(modelCardCandidate) ? modelCardCandidate : undefined

	const crfCandidate = resolve(packageDir, "crf-transitions.json")
	const crfTransitionsPath = existsSync(crfCandidate) ? crfCandidate : undefined

	return { modelPath, tokenizerPath, modelCardPath, crfTransitionsPath, source: `package:${packageName}` }
}

/**
 * Read the `labels` array from a `model-card.json` file. Returns `undefined` when the file is
 * missing, unreadable, malformed, or has no `labels` field — callers should fall back to their
 * compile-time default in that case (the loader contract: the JS-side default tracks the most
 * recent shipped stage, so a card without `labels` is always a pre-v0.4.0 card whose label vocab
 * matches that default by construction).
 *
 * Validates shape: must be a non-empty array of strings. Throws on a present-but-malformed `labels`
 * field — a card that emits e.g. `labels: 21` rather than `labels: [...]` is a corrupted artifact
 * and should be loud, not silently re-defaulted.
 */
export function readLabelsFromModelCard(modelCardPath: string | undefined): readonly string[] | undefined {
	if (!modelCardPath || !existsSync(modelCardPath)) return undefined
	let raw: string
	try {
		raw = readFileSync(modelCardPath, "utf8")
	} catch {
		return undefined
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (typeof parsed !== "object" || parsed === null) return undefined
	const labels = (parsed as { labels?: unknown }).labels
	if (labels === undefined) return undefined
	if (!Array.isArray(labels) || labels.length === 0 || !labels.every((l) => typeof l === "string")) {
		throw new Error(
			`model-card.json at ${modelCardPath} has a malformed \`labels\` field — ` +
				`expected a non-empty array of strings, got ${JSON.stringify(labels)}.`
		)
	}
	return Object.freeze(labels.slice()) as readonly string[]
}

export interface CrfTransitions {
	transitions: number[][]
	startTransitions: number[]
	endTransitions: number[]
}

/**
 * Read learned CRF transition parameters from `crf-transitions.json`. Returns `undefined` when the
 * file is missing or malformed — callers fall back to the structural BIO mask only.
 */
export function readCrfTransitions(crfPath: string | undefined): CrfTransitions | undefined {
	if (!crfPath || !existsSync(crfPath)) return undefined
	let raw: string
	try {
		raw = readFileSync(crfPath, "utf8")
	} catch {
		return undefined
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (typeof parsed !== "object" || parsed === null) return undefined
	const obj = parsed as Record<string, unknown>
	const transitions = obj.transitions
	const start = obj.start_transitions
	const end = obj.end_transitions
	if (!Array.isArray(transitions) || !Array.isArray(start) || !Array.isArray(end)) return undefined
	if (transitions.length === 0 || start.length === 0 || end.length === 0) return undefined
	return {
		transitions: transitions as number[][],
		startTransitions: start as number[],
		endTransitions: end as number[],
	}
}
