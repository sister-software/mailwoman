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
	 * Per-call locale hint — the row's country-derived tag (e.g. `en-GB` for a GB row). Threaded into the pipeline's
	 * normalize / query-shape / locale-hint stages exactly as a production caller hint would be. The classifier itself is
	 * loaded once per run from `ModelSelectOptions.locale`.
	 */
	locale?: string
}

export type ParseFn = (raw: string, opts?: ParseCallOpts) => Promise<Record<string, string>>

/**
 * Options that select a model — mirrors the shape of `eval promote` / `eval error-analysis`.
 */
export interface ModelSelectOptions {
	/**
	 * Candidate ONNX (requires `tokenizer` + `modelCard`, or falls back to co-located siblings via `weightsCache`).
	 */
	model?: string
	tokenizer?: string
	modelCard?: string
	/**
	 * Package-shaped weights dir (`<root>/node_modules/@mailwoman/neural-weights-<locale>`) — #718-safe, resolves model +
	 * tokenizer + card + anchor/gazetteer siblings via `loadFromWeights`. Preferred over `model` for grading a candidate
	 * whose vocab differs (splice), and the only correct grade for a country-channel model. Alternative to `model`.
	 */
	weightsCache?: string
	/**
	 * BCP-47-ish locale tag for weights-package resolution (which classifier + FST is loaded). Default `en-US`. This is
	 * the RUN's locale — the per-row parse locale is derived from each fixture row's country via `localeForCountry`.
	 */
	locale?: string
}

/**
 * The suite's fixture rows are keyed by ISO country code; the production pipeline wants a BCP-47 locale tag. These are
 * the tags for the four countries `suite.jsonl` carries (DE, FR, GB, US), and nothing more: the gauntlet's
 * `OVERLAY_LOCALE_BY_COUNTRY` lists the overlay locales (GB, NZ, DE, IN, ES, IT) and this table lists the suite's, and
 * they overlap on GB and DE only. An unlisted country falls back to en-US, so a row added for a country that ships an
 * overlay (ES, IT, NZ, IN) parses under the wrong weights unless its entry is added here beside the row.
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
 * Build a `ParseFn` from model-select options. Exported so `--baseline` can build a second, independent classifier.
 *
 * Routing (#1516): every parse runs through the PRODUCTION path — `createRuntimePipeline` — not the raw
 * `classifier.parse` the old runner used. That is the point of the probe: the release Gauntlet measures the
 * user-visible pipeline, and a metamorphic probe that bypasses it (no #690 case normalization, no locale-hint, no
 * kind/grouping stages, no weights-package FST auto-load) manufactures violations the shipped path never exhibits — and
 * misses the D-rule regressions that DO ride the pipeline stages. With a `weightsCache` classifier this is fully
 * production-faithful: `loadFromWeights` surfaces `fstPath`, which `createRuntimePipeline`'s `autoLoadWeightsFST` uses
 * to load the locale FST from the weights package. The `--model` scorer path carries no FST (matching the gauntlet's
 * legacy `createScorer` modes — the FST belongs to the weights package, not the scorer).
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
