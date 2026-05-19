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

import { existsSync } from "node:fs"
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

	const locale = opts.locale ?? "en-us"
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

	return { modelPath, tokenizerPath, source: `package:${packageName}` }
}
