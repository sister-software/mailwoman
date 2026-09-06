/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Environment variables the `mailwoman` CLI and runtime pipeline read, and the overrides its evaluation tooling
 * accepts. The resolver's database paths are inherited from `@mailwoman/resolver-wof-sqlite/env`.
 */

import { blankAsAbsent } from "@mailwoman/core/env/utils"
import { z } from "zod"

const RuntimeEnvSchema = z.object({
	/**
	 * Operator locale override used when a request supplies no locale. Safe to expose in diagnostics.
	 */
	MW_LOCALE: z
		.string()
		.min(1)
		.optional()
		.meta({
			title: "Default locale",
			description: "BCP-47 locale override used when a request supplies no locale.",
			examples: ["en-US", "fr-FR"],
		}),
	// Geocode server batch row cap (`POST /v1/batch`).
	//
	// `MAILWOMAN_BATCH_CONCURRENCY` was REMOVED — it was inert. In-process concurrency cannot overlap a geocode:
	// `onnxruntime-node`'s `session.run()` blocks the JS thread instead of releasing to the libuv pool, and
	// `node:sqlite` reads are synchronous. Measured 1.00x flat from 1→16 workers on both parse and full geocode. Don't
	// reintroduce it without re-measuring; worker threads (see `mailwoman/geocode-stream.ts`) are the only change that
	// moves this in Node. Receipts: `docs/engineering/reference/performance.mdx`.
	MAILWOMAN_BATCH_MAX: blankAsAbsent(z.coerce.number().int().positive().default(1000)).meta({
		title: "Batch row limit",
		description: "Maximum rows accepted by `POST /v1/batch` when running `mailwoman serve`.",
	}),
	// The informal-standard color kill switch (no-color.org). chalk/Ink honor it on their own; declared here because the
	// debug view's map pane emits raw SGR and must consult it itself — the schema strips unlisted vars.
	NO_COLOR: z.string().optional().meta({
		title: "Disable color",
		description: "Disables ANSI color output, following the informal NO_COLOR convention.",
	}),
	MAILWOMAN_FST_BIN: z.string().optional().meta({
		title: "Autocomplete gazetteer index",
		description: "Path to the FST gazetteer index used by Mailwoman autocomplete.",
	}),
	MAILWOMAN_MODEL_CARD: z.string().optional().meta({
		title: "Model card",
		description: "Path to the model card exposed by server health reporting.",
	}),
	// PMTiles archive for the geocode --debug map pane; --tiles outranks it at the call site.
	MAILWOMAN_TILES: z.string().optional().meta({
		title: "Debug map tiles",
		description: "Path to the PMTiles archive used by the geocode debug map pane; `--tiles` takes precedence.",
	}),
	PYTHON: z.string().optional().meta({
		title: "Python executable",
		description: "Python executable override used by the export-verification developer tools.",
	}),
})

const EvaluationEnvSchema = z.object({
	MAILWOMAN_WOF_GLOBAL_DB: z.string().optional().meta({
		title: "Evaluation global admin database",
		description: "Admin gazetteer override used by the default-country evaluation panel.",
	}),
	MAILWOMAN_DIAG_INTERP: z.string().optional().meta({
		title: "Interpolation diagnostics",
		description: "Set to `1` to emit interpolation coverage diagnostics during resolver evaluation.",
	}),
	MAILWOMAN_DUMP_MISS_TAG: z.string().optional().meta({
		title: "Dump missed tag",
		description: "Tag whose false negatives and mislabels are printed by per-locale evaluation tooling.",
	}),
	MAILWOMAN_WORD_CONSISTENCY: z.string().optional().meta({
		title: "Word consistency mode",
		description: "Evaluation override controlling the word-consistency healing behavior used by neural parsing.",
	}),
	MAILWOMAN_COLD_START_FULL: z.string().optional().meta({
		title: "Full cold-start test",
		description: "Enables the with-data cold-start suite that pulls candidate data and boots all drop-in servers.",
	}),
	MAILWOMAN_COLD_START_DATA_ROOT: z.string().optional().meta({
		title: "Cold-start data root",
		description: "Existing populated data root reused by the conditional full cold-start suite.",
	}),
})

/**
 * Non-secret settings the CLI, the runtime pipeline and the evaluation tooling read.
 */
export const PublicMailwomanEnvSchema = z.object({
	...RuntimeEnvSchema.shape,
	...EvaluationEnvSchema.shape,
})

/**
 * Secrets the CLI's publishing and evaluation commands send. Never log their values.
 */
export const PrivateMailwomanEnvSchema = z.object({
	// R2/S3 upload credentials for `tiles publish` and `corpus upload` (rclone `:s3:` remote).
	RCLONE_S3_ENDPOINT: z.string().optional().meta({
		title: "S3 endpoint",
		description: "S3-compatible endpoint used by rclone when publishing tile and corpus artifacts.",
	}),
	RCLONE_S3_ACCESS_KEY_ID: z.string().optional().meta({
		title: "S3 access key ID",
		description: "S3-compatible access key ID used by rclone when publishing tile and corpus artifacts.",
	}),
	RCLONE_S3_SECRET_ACCESS_KEY: z.string().optional().meta({
		title: "S3 secret access key",
		description: "S3-compatible secret access key used by rclone when publishing tile and corpus artifacts.",
	}),
	/**
	 * Per-run secret salting the published case identifiers of a controlled premise-linkage evaluation (`mailwoman eval
	 * premise-linkage`). A secret rather than config: two reports salted alike can be joined row for row into a longer
	 * record of the same premises, which is the linkage the identifier exists to prevent.
	 */
	MAILWOMAN_PREMISE_LINKAGE_SALT: z.string().optional().meta({
		title: "Premise-linkage salt",
		description: "Per-run secret used to salt published case identifiers in controlled premise-linkage evaluations.",
	}),
})
