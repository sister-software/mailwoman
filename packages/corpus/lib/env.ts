/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Environment variables the corpus build and its acquisition tooling read.
 */

import { $private as corePrivate, $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { z } from "zod"

/**
 * Corpus build settings.
 */
export const PublicCorpusEnvSchema = z.object({
	MAILWOMAN_RESUME: z.string().optional().meta({
		title: "Build resume",
		description: "Resume-state override used by corpus build tooling.",
	}),
})

/**
 * Credentials the corpus acquisition and golden-expansion tooling send. Never log their values.
 */
export const PrivateCorpusEnvSchema = z.object({
	// OpenAddresses batch-download API token (`corpus/lib/tools/fetch/openaddresses.ts`).
	OA_BATCH_TOKEN: z.string().optional().meta({
		title: "OpenAddresses batch token",
		description: "API token used by the OpenAddresses batch-download corpus fetcher.",
	}),
	// LLM API keys for the corpus golden-expansion tooling.
	DEEPSEEK_API_KEY: z.string().optional().meta({
		title: "DeepSeek API key",
		description: "API key used by corpus golden-expansion tooling when calling DeepSeek.",
	}),
	ANTHROPIC_API_KEY: z.string().optional().meta({
		title: "Anthropic API key",
		description: "API key used by corpus golden-expansion tooling when calling Anthropic.",
	}),
})

/**
 * Live corpus settings over core's, sharing core's getters and cached values.
 */
export const $public = liveEnv(PublicCorpusEnvSchema, corePublic)

/**
 * Live corpus credentials over core's. Never log their values.
 */
export const $private = liveEnv(PrivateCorpusEnvSchema, corePrivate)
