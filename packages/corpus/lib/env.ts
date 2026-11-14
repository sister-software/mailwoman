// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Environment variables the corpus build and its acquisition tooling read.
 */

import { $private as corePrivate, $public as corePublic, liveEnv } from "@mailwoman/core/env"
import { blankAsAbsent } from "@mailwoman/core/env/utils"
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
	// The mount the training volume's paths start with.
	// A manifest built on Modal lists its files under it.
	MAILWOMAN_VOLUME_MOUNT: blankAsAbsent(z.string().default("/data")).meta({
		title: "Training volume mount",
		description:
			"The path the training volume is mounted at. A config or manifest path under it reads the copy under the data root on a host that mirrors the volume.",
	}),
	// The training sampler's sidecar of measured corpus-file sha256s (`mtf-sampler/src/sha256_cache.rs`).
	MAILWOMAN_SHA256_CACHE: blankAsAbsent(z.string().optional()).meta({
		title: "Corpus sha256 cache",
		description:
			"A JSON file where the training sampler remembers each corpus file's measured sha256 by path, size and modification time. Unset hashes every file the sampler opens.",
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
	// Wikidata bot-password login for the vital-places fetcher (`lib/tools/fetch/wikidata/session.ts`).
	// Set both or neither.
	WIKIDATA_BOT_USERNAME: blankAsAbsent(z.string().optional()).meta({
		title: "Wikidata bot username",
		description:
			"Bot-password login of the form Name@app, from Special:BotPasswords. With WIKIDATA_BOT_PASSWORD it logs the wikidata-vital-places fetcher in, which raises its Action API concurrency from 1 to 3. Unset fetches anonymously.",
	}),
	WIKIDATA_BOT_PASSWORD: blankAsAbsent(z.string().optional()).meta({
		title: "Wikidata bot password",
		description: "The generated password of the bot-password login in WIKIDATA_BOT_USERNAME.",
	}),
	// LLM API keys for the corpus golden-expansion tooling and the DeepSeek generator.
	DEEPSEEK_API_KEY: z.string().optional().meta({
		title: "DeepSeek API key",
		description:
			"API key used by corpus golden-expansion tooling and the DeepSeek corpus generator (`lib/tools/deepseek.run.ts`) when calling DeepSeek.",
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
