/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Invariance production parser construction.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolvePath } from "path-ts"

import { createRuntimePipeline } from "#index"

export interface ParseCallOpts {
	/**
	 * Per-row locale hint, derived from the fixture country.
	 */
	locale?: string
}

export type ParseFn = (raw: string, opts?: ParseCallOpts) => Promise<Record<string, string>>

/**
 * Model-selection options shared with evaluation commands.
 */
export interface ModelSelectOptions {
	/**
	 * Candidate ONNX; requires tokenizer and model card unless using `weightsCache`.
	 */
	model?: string
	tokenizer?: string
	modelCard?: string
	/**
	 * Package-shaped candidate weights root; resolves model and runtime siblings together.
	 */
	weightsCache?: string
	/**
	 * Locale for weights-package resolution; defaults to `en-US`.
	 * Each row's parse locale comes from its country.
	 */
	locale?: string
}

/**
 * Locale tags for countries used by the invariance suite.
 *
 * Unlisted countries fall back to `en-US` and need an entry if added to the suite.
 */
export const COUNTRY_TO_LOCALE: Readonly<Record<string, string>> = {
	US: "en-US",
	GB: "en-GB",
	FR: "fr-FR",
	DE: "de-DE",
}

export function localeForCountry(country: string): string {
	return COUNTRY_TO_LOCALE[country] ?? "en-US"
}

async function buildClassifier(opts: ModelSelectOptions): Promise<NeuralAddressClassifier> {
	const locale = opts.locale ?? "en-US"

	if (opts.weightsCache) {
		return NeuralAddressClassifier.loadFromWeights({ locale, cacheRoot: opts.weightsCache })
	}

	if (opts.model) {
		if (!opts.tokenizer || !opts.modelCard) {
			throw new Error("--model requires --tokenizer and --model-card (or pass --weights-cache instead)")
		}

		return createScorer({
			modelPath: resolvePath(opts.model),
			tokenizerPath: resolvePath(opts.tokenizer),
			modelCardPath: resolvePath(opts.modelCard),
			locale: locale.toLowerCase(),
		})
	}

	return NeuralAddressClassifier.loadFromWeights({ locale })
}

/**
 * Build a parser through the production runtime pipeline.
 *
 * A weights package also supplies its locale FST; a standalone ONNX scorer does not.
 */
export async function buildParseFn(opts: ModelSelectOptions): Promise<ParseFn> {
	const classifier = await buildClassifier(opts)

	const pipeline = createRuntimePipeline({ classifier })

	return async (raw: string, callOpts?: ParseCallOpts) => {
		const runOpts = callOpts?.locale ? { locale: callOpts.locale } : undefined

		return decodeAsJSON((await pipeline(raw, runOpts)).tree) as Record<string, string>
	}
}

//#endregion
