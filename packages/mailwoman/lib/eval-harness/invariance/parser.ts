/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @file Builds the production parser that the invariance runner calls.
 */

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createScorer } from "@mailwoman/neural/scorer"
import { resolvePath } from "path-ts"

import { createRuntimePipeline } from "#index"

/**
 * Per-call parser options.
 */
export interface ParseCallOpts {
	/**
	 * Locale hint for the row, derived from the fixture's country.
	 */
	locale?: string
}

/**
 * Parser that returns the decoded component map for one input.
 */
export type ParseFn = (raw: string, opts?: ParseCallOpts) => Promise<Record<string, string>>

/**
 * Model-selection options shared with the evaluation commands.
 */
export interface ModelSelectOptions {
	/**
	 * Candidate ONNX model path.
	 *
	 * It requires `tokenizer` and `modelCard` unless `weightsCache` is set.
	 */
	model?: string
	tokenizer?: string
	modelCard?: string
	/**
	 * Candidate weights root laid out like a weights package.
	 * It takes precedence over `model`.
	 */
	weightsCache?: string
	/**
	 * Locale used to resolve the weights package.
	 *
	 * It defaults to `en-US`.
	 * Each row's parse locale still comes from its country.
	 */
	locale?: string
}

/**
 * Locale tag for each country in the invariance suite.
 *
 * A country added to the suite needs an entry here, because unlisted countries fall back to `en-US`.
 */
export const COUNTRY_TO_LOCALE: Readonly<Record<string, string>> = {
	US: "en-US",
	GB: "en-GB",
	FR: "fr-FR",
	DE: "de-DE",
}

/**
 * Returns the locale tag for a country, or `en-US` when the country is unlisted.
 */
export function localeForCountry(country: string): string {
	return COUNTRY_TO_LOCALE[country] ?? "en-US"
}

/**
 * Loads the classifier from `weightsCache`, from a standalone ONNX model,
 * or from the installed weights, in that order of precedence.
 */
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
 * Builds a parser on the production runtime pipeline.
 *
 * A weights package also supplies its locale FST.
 * A standalone ONNX scorer runs without one.
 */
export async function buildParseFn(opts: ModelSelectOptions): Promise<ParseFn> {
	const classifier = await buildClassifier(opts)

	const pipeline = createRuntimePipeline({ classifier })

	return async (raw: string, callOpts?: ParseCallOpts) => {
		const runOpts = callOpts?.locale ? { locale: callOpts.locale } : undefined

		return decodeAsJSON((await pipeline(raw, runOpts)).tree) as Record<string, string>
	}
}
