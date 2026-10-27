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
 *
 * Empty: whether a build resumes is the `priorOutput` option of `buildCorpus`, chosen per run.
 */
export const PublicCorpusEnvSchema = z.object({
	// The corpus manifest `held-out-spans.full.test.ts` scans, or `default` for the latest base corpus.
	MAILWOMAN_HOLDOUT_CHECK_MANIFEST: z.string().optional().meta({
		title: "Holdout check manifest",
		description:
			"Corpus manifest whose region and locality spans the holdout span check counts; `default` reads the latest base corpus. Unset skips the check.",
	}),
	// The directory the WOF adapters keep parsed records in between builds (`adapters/wof/record-cache.ts`).
	MAILWOMAN_WOF_RECORD_CACHE: z.string().optional().meta({
		title: "WOF record cache",
		description:
			"Directory where the WOF adapters keep the records parsed from the GeoJSON checkouts, keyed by every file's path, size and modification time; a relative path resolves against the data root. Unset parses the GeoJSON on every build.",
	}),
})

/**
 * Credentials the corpus acquisition and golden-expansion tooling send.
 *
 * Never log their values.
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
 * Live corpus credentials over core's.
 *
 * Never log their values.
 */
export const $private = liveEnv(PrivateCorpusEnvSchema, corePrivate)
