/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The model and tokenizer a model-conditional test suite runs against.
 *
 *   `MAILWOMAN_TEST_ONNX_MODEL` overrides the model to run against the tokenizer fixture. Without it,
 *   suites use the packaged en-US weights. `mwops release copy-weights` materializes those in CI and
 *   `link-dev-weights.ts` links them on a developer host. A checkout with neither answers `null`, and a
 *   suite that reads `null` skips rather than asserting on a model it does not have.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { workspacePath } from "@mailwoman/core/paths"

import { $public } from "#env"
import { resolveWeights } from "#weights"

/**
 * The tokenizer the fixture-driven suites pair with an override model.
 */
export const FIXTURE_TOKENIZER_PATH = workspacePath("neural", "test", "fixtures", "tokenizer-v0.1.0.model")

/**
 * The per-test budget for a suite whose first test loads a model.
 *
 * A load takes a few seconds on an idle host and tens of seconds on the lab host while a CI leg
 * or another session runs beside it, so the default 15 s budget times out the loading test
 * under load while every later test passes, because it reads the loaded instance.
 */
export const MODEL_LOAD_TEST_TIMEOUT_MS = 120_000

export interface TestModelAssets {
	modelPath: string
	tokenizerPath: string
	/**
	 * Where the model came from: the environment override, or the packaged en-US weights.
	 */
	source: "override" | "packaged"
}

/**
 * The model and tokenizer for a model-conditional suite, or `null` when this checkout
 * has neither an override nor materialized en-US weights.
 */
export async function testModelAssets(): Promise<TestModelAssets | null> {
	const override = $public.MAILWOMAN_TEST_ONNX_MODEL

	if (override) {
		return (await pathExists(override))
			? { modelPath: override, tokenizerPath: FIXTURE_TOKENIZER_PATH.toString(), source: "override" }
			: null
	}

	try {
		const weights = await resolveWeights({ locale: "en-US" })

		if (weights.modelPath && weights.tokenizerPath && (await pathExists(weights.modelPath))) {
			return { modelPath: weights.modelPath, tokenizerPath: weights.tokenizerPath, source: "packaged" }
		}
	} catch {
		// A lean checkout resolves no weights package.
		// That is the `null` answer below.
	}

	return null
}
