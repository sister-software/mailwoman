/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Environment variables the neural classifier reads at load time, and the model overrides its test suites accept.
 *   Node-only: the loader reaches this module through a `webpackIgnore` dynamic import so the browser chunk graph
 *   never follows it.
 */

import { $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { z } from "zod"

/**
 * Inference tuning and evaluation overrides for the neural classifier.
 */
export const PublicNeuralEnvSchema = z.object({
	// ONNX intra-op thread cap. Deployment-shaped rather than code-shaped: the right value depends on how many
	// mailwoman processes share the host, which the library cannot know. See DEFAULT_INTRA_OP_THREADS.
	MAILWOMAN_INTRA_OP_THREADS: blankAsAbsent(z.coerce.number().int().positive().optional()).meta({
		title: "ONNX intra-op threads",
		description: "Maximum ONNX Runtime intra-op worker threads for each Mailwoman process.",
	}),
	/**
	 * PIX1 whole-edge parent bias (#46) — the δ applied to the PARENT window of a placetype-pair hit, over the child
	 * tag's allowed parents in `containmentFor(system)`. UNSET (the default) = child-only, byte-identical to every
	 * pre-#46 build.
	 *
	 * A bar-conditional toggle, not a shipped knob: the mechanism stays off until the four bars in
	 * `docs/superpowers/plans/2026-08-04-pix1-whole-edge-preregistration.md` clear, and this is how the ON leg of B-1's
	 * ON-vs-OFF comparison is driven through `mailwoman eval gauntlet` without a code edit between the two runs.
	 */
	MAILWOMAN_PAIR_PARENT_DELTA: blankAsAbsent(z.coerce.number().optional()).meta({
		title: "Pair-parent delta",
		description: "Experimental PIX1 parent-window bias applied during placetype-pair evaluation.",
	}),
	MAILWOMAN_TEST_ONNX_MODEL: z.string().optional().meta({
		title: "Test ONNX model",
		description: "ONNX model override exercised by neural test suites.",
	}),
	MAILWOMAN_CAPABILITY_ONNX_MODEL: z.string().optional().meta({
		title: "Capability-check ONNX model",
		description: "ONNX model override exercised by the capability check.",
	}),
})

/**
 * Live neural settings over core's, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicNeuralEnvSchema, corePublic)
