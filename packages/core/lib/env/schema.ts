/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file Environment schema definitions for the Mailwoman runtime and tooling.
 */

import { z } from "zod"

import { DefaultMailwomanPaths } from "#env/paths"
import { blankAsAbsent } from "#env/utils"

// #region Public

const RuntimeEnvSchema = z.object({
	// `.catch` (not `.default`) so an unknown value never throws — vitest sets NODE_ENV=test, CI may set others.
	NODE_ENV: z.enum(["development", "production", "test"]).catch("development").meta({
		title: "Node environment",
		description: "Runtime environment. Unknown values fall back to development.",
	}),
	CI: z.coerce.boolean().default(false).meta({
		title: "Continuous integration",
		description: "Whether the process is running in a continuous integration environment.",
	}),

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
	// ONNX intra-op thread cap. Deployment-shaped rather than code-shaped: the right value depends on how many
	// mailwoman processes share the host, which the library cannot know. See DEFAULT_INTRA_OP_THREADS.
	//
	MAILWOMAN_INTRA_OP_THREADS: blankAsAbsent(z.coerce.number().int().positive().optional()).meta({
		title: "ONNX intra-op threads",
		description: "Maximum ONNX Runtime intra-op worker threads for each Mailwoman process.",
	}),
	// Geocode server batch row cap (`POST /v1/batch`).
	//
	// `MAILWOMAN_BATCH_CONCURRENCY` was REMOVED 2026-07-16 — it was inert. In-process concurrency
	// cannot overlap a geocode: `onnxruntime-node`'s `session.run()` blocks the JS thread instead of
	// releasing to the libuv pool, and `node:sqlite` reads are synchronous. Measured 1.00x flat from
	// 1→16 workers on both parse and full geocode. Don't reintroduce it without re-measuring; worker
	// threads (see `mailwoman/geocode-stream.ts`) are the only change that moves this in Node.
	// Receipts: `docs/engineering/reference/performance.mdx`.
	MAILWOMAN_BATCH_MAX: blankAsAbsent(z.coerce.number().int().positive().default(1000)).meta({
		title: "Batch row limit",
		description: "Maximum rows accepted by `POST /v1/batch` when running `mailwoman serve`.",
	}),
	// The informal-standard color kill switch (no-color.org). chalk/Ink honor it on their own; declared here because the debug view's map pane emits raw SGR and must consult it itself — the schema strips unlisted vars.
	NO_COLOR: z.string().optional().meta({
		title: "Disable color",
		description: "Disables ANSI color output, following the informal NO_COLOR convention.",
	}),
})

const ResolverEnvSchema = z.object({
	// Gazetteer / resolver database paths. CLI flags (`--resolve-db`, …) override these at the call site.
	MAILWOMAN_WOF_DB: z.string().optional().meta({
		title: "Who's On First database",
		description: "Path to a full Who's On First SQLite distribution used by the search resolver backend.",
	}),
	MAILWOMAN_WOF_ADMIN_DB: z.string().optional().meta({
		title: "Who's On First admin database",
		description: "Path to the full Who's On First distribution used for reverse geocoding.",
	}),
	MAILWOMAN_WOF_POLYGONS_DB: z.string().optional().meta({
		title: "Who's On First polygon database",
		description: "Path to the polygon sidecar used for exact reverse-geocode containment.",
	}),

	MAILWOMAN_CANDIDATE_DB: z.string().optional().meta({
		title: "Candidate database",
		description: "Path to candidate.db; set to `none` to pin the full-distribution search backend.",
	}),
	MAILWOMAN_POSTAL_CITY_ALIAS_DB: z.string().optional().meta({
		title: "Postal city alias database",
		description: "Path to postal-city alias data used for alias-aware resolution of U.S. mailing addresses.",
	}),
	MAILWOMAN_FST_BIN: z.string().optional().meta({
		title: "Autocomplete gazetteer index",
		description: "Path to the FST gazetteer index used by Mailwoman autocomplete.",
	}),
	MAILWOMAN_MODEL_CARD: z.string().optional().meta({
		title: "Model card",
		description: "Path to the model card exposed by server health reporting.",
	}),
	MAILWOMAN_COARSE_PLACER_DIR: z.string().optional().meta({
		title: "Coarse placer directory",
		description: "Directory containing the coarse country-placement model artifacts.",
	}),
	// PMTiles archive for the geocode --debug map pane; --tiles outranks it at the call site.
	MAILWOMAN_TILES: z.string().optional().meta({
		title: "Debug map tiles",
		description: "Path to the PMTiles archive used by the geocode debug map pane; `--tiles` takes precedence.",
	}),
})

const StorageEnvSchema = z.object({
	// Platform-native application directories. Environment values override these defaults.
	//
	// A bare `.default()` fires only on `undefined`, so a present-but-empty variable passes validation intact.
	MAILWOMAN_DATA_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.data)).meta({
		title: "Data root",
		description: "Root directory for downloaded Mailwoman data and runtime artifacts.",
	}),
	MAILWOMAN_CONFIG_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.config)).meta({
		title: "Config root",
		description: "Directory for Mailwoman configuration files.",
	}),
	MAILWOMAN_CACHE_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.cache)).meta({
		title: "Cache root",
		description: "Directory for reusable downloaded and generated caches.",
	}),
	MAILWOMAN_TEMP_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.temp)).meta({
		title: "Temporary root",
		description: "Directory for named temporary outputs and evaluation staging.",
	}),
})

const TrainingEnvSchema = z.object({
	// Python training driver (`corpus-python/scripts/train_with_resume.ts`) + build resume (`corpus/src/build.ts`).
	MAX_ATTEMPTS: z.string().optional().meta({
		title: "Training attempts",
		description: "Maximum retry attempts used by the Python training driver.",
	}),
	LOG: z.string().optional().meta({
		title: "Training log",
		description: "Log destination override used by the Python training driver.",
	}),
	CONFIG: z.string().optional().meta({
		title: "Training config",
		description: "Configuration path override used by the Python training driver.",
	}),
	PYTHON: z.string().optional().meta({
		title: "Python executable",
		description: "Python executable override used by training tooling.",
	}),
	MAILWOMAN_RESUME: z.string().optional().meta({
		title: "Build resume",
		description: "Resume-state override used by corpus build tooling.",
	}),
})

const DevelopmentWeightsEnvSchema = z.object({
	MAILWOMAN_DEV_MODEL: z.string().optional().meta({
		title: "Development model",
		description: "Path to the model artifact linked for local neural-weights development.",
	}),
	MAILWOMAN_DEV_TOKENIZER: z.string().optional().meta({
		title: "Development tokenizer",
		description: "Path to the tokenizer artifact linked for local neural-weights development.",
	}),
})

const EvaluationEnvSchema = z.object({
	MAILWOMAN_WOF_HOT_DB: z.string().optional().meta({
		title: "Evaluation WOF hot database",
		description: "Who's On First database override used by evaluation tooling.",
	}),
	MAILWOMAN_DEMO_URL: z.string().optional().meta({
		title: "Deployed demo URL",
		description: "Deployed demo URL used by the documentation end-to-end suite instead of a local build.",
	}),
	MAILWOMAN_TEST_ONNX_MODEL: z.string().optional().meta({
		title: "Test ONNX model",
		description: "ONNX model override exercised by neural test suites.",
	}),
	MAILWOMAN_CAPABILITY_ONNX_MODEL: z.string().optional().meta({
		title: "Capability-check ONNX model",
		description: "ONNX model override exercised by the capability check.",
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
})

const LicenseEnvSchema = z.object({
	MAILWOMAN_DOCS_URL: z.string().optional().meta({
		title: "Documentation URL",
		description: "Base URL used by documentation and demo tooling.",
	}),
	/**
	 * A signed commercial license key (`mwl1.<payload>.<signature>`, Ed25519 over the payload, verified offline against
	 * the public keys `@mailwoman/core/license` ships). Its presence changes what `mailwoman doctor` reports about the
	 * license that applies to this installation; it never changes what the runtime does. Absent means the AGPL-3.0-only
	 * branch applies. Public in the sense that it is a signed assertion, not a secret, but the doctor prints the licensee
	 * and expiry rather than the token.
	 */
	MAILWOMAN_LICENSE_KEY: blankAsAbsent(z.string().min(1).optional()).meta({
		title: "Commercial license key",
		description: "Signed commercial license assertion used by `mailwoman doctor`; it does not change runtime behavior.",
	}),
	/**
	 * The license worker's origin (`https://license.mailwoman.ai` when unset), for `mailwoman license refresh` and the
	 * online per-license status. Pointed at a sandbox deploy or a test stub.
	 */
	MAILWOMAN_LICENSE_URL: blankAsAbsent(z.string().min(1).optional()).meta({
		title: "License service URL",
		description: "License-service origin used by license refresh and online status checks.",
	}),
})

/**
 * Non-secret operational config, exposed via `$public`. Add a key here to make it visible to the runtime; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PublicEnvSchema = z
	.object({
		...RuntimeEnvSchema.shape,
		...ResolverEnvSchema.shape,
		...StorageEnvSchema.shape,
		...TrainingEnvSchema.shape,
		...DevelopmentWeightsEnvSchema.shape,
		...LicenseEnvSchema.shape,
		...EvaluationEnvSchema.shape,
	})
	.meta({
		title: "Public environment configuration",
		description: "Non-secret operational configuration exposed through `$public`.",
	})

// #end region

// #region Private

/**
 * Secrets and credentials, exposed via `$private`. Never log these. Add a key here to make it available; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PrivateEnvSchema = z
	.object({
		// #region Hugging Face

		HF_BUCKET_URI: z
			.string()
			.optional()
			.meta({
				title: "Hugging Face bucket URI",
				description: "Private bucket URI used by Hugging Face model or artifact tooling.",
				examples: ["hf://buckets/sister-software/mailwoman"],
			}),
		HF_ORG_NAME: z
			.string()
			.optional()
			.meta({
				title: "Hugging Face organization",
				description: "Hugging Face organization name used by model or artifact tooling.",
				examples: ["sister-software"],
			}),
		HF_BUCKET_NAME: z
			.string()
			.optional()
			.meta({
				title: "Hugging Face bucket name",
				description: "Private Hugging Face bucket name used by model or artifact tooling.",
				examples: ["mailwoman"],
			}),
		HF_BUCKET_RESOLVE_URL: z
			.url()
			.optional()
			.meta({
				title: "Hugging Face bucket resolve URL",
				description: "Resolve URL used to access artifacts stored in the Hugging Face bucket.",
				examples: ["https://huggingface.co/buckets/sister-software/mailwoman/resolve/"],
			}),
		HF_TOKEN: z.string().min(1, "HF_TOKEN required").optional().meta({
			title: "Hugging Face token",
			description: "Authentication token used for Hugging Face API and artifact access.",
		}),

		// #endregion

		// #region Stripe

		MAILWOMAN_STRIPE_SECRET_KEY: z.string().optional().meta({
			title: "Stripe secret key",
			description: "Secret API key used by Mailwoman Stripe integrations.",
		}),

		// #endregion

		CF_AUTH_TOKEN: z.string().optional().meta({
			title: "Cloudflare auth token",
			description: "Authentication token used by Cloudflare tooling and deployments.",
		}),
		GEOCODE_EARTH_API_KEY: z.string().optional().meta({
			title: "Geocode Earth API key",
			description: "API key used to access Geocode Earth services.",
		}),
		// UK EPC bulk-download API token (en-GB acquisition — EPC certificates, UPRN-joinable).
		UK_EPC_TOKEN: z.string().optional().meta({
			title: "UK EPC API token",
			description: "API token used to bulk-download UK Energy Performance Certificate data.",
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
		// R2/S3 upload credentials for `tiles publish` (rclone `:s3:` remote).
		RCLONE_S3_ENDPOINT: z.string().optional().meta({
			title: "S3 endpoint",
			description: "S3-compatible endpoint used by rclone when publishing tile artifacts.",
		}),
		RCLONE_S3_ACCESS_KEY_ID: z.string().optional().meta({
			title: "S3 access key ID",
			description: "S3-compatible access key ID used by rclone when publishing tile artifacts.",
		}),
		RCLONE_S3_SECRET_ACCESS_KEY: z.string().optional().meta({
			title: "S3 secret access key",
			description: "S3-compatible secret access key used by rclone when publishing tile artifacts.",
		}),
		// OpenAddresses batch-download API token (`corpus/src/tools/fetch/openaddresses.ts`).
		OA_BATCH_TOKEN: z.string().optional().meta({
			title: "OpenAddresses batch token",
			description: "API token used by the OpenAddresses batch-download corpus fetcher.",
		}),
		// FCC Broadband Map (BDC) public-API credentials (`bdc/sdk/client.ts`) — username + hash_value header auth.
		FCC_MAP_USERNAME: z.string().optional().meta({
			title: "FCC Broadband Map username",
			description: "Username used to authenticate to the FCC Broadband Data Collection API.",
		}),
		FCC_MAP_API_KEY: z.string().optional().meta({
			title: "FCC Broadband Map API key",
			description: "API key hash used to authenticate to the FCC Broadband Data Collection API.",
		}),
		SEC_EDGAR_USER_AGENT: z
			.string()
			.optional()
			.meta({
				title: "SEC EDGAR User-Agent",
				description: "Identifying User-Agent required for SEC EDGAR fair-access requests.",
				examples: ["Company Name AdminContact@domain.com"],
			}),
		/**
		 * Descriptive User-Agent for the FCC CORES lookup (`filer/sdk/cores-client.ts`). Optional in a way
		 * `SEC_EDGAR_USER_AGENT` is not: SEC 403s a request that fails to identify itself, FCC does not. Falls back to
		 * `SEC_EDGAR_USER_AGENT` — the same contact address — when unset.
		 */
		FCC_CORES_USER_AGENT: z.string().optional().meta({
			title: "FCC CORES User-Agent",
			description:
				"Descriptive User-Agent used for FCC CORES requests; falls back to the SEC EDGAR User-Agent when unset.",
		}),
		USAC_API_KEY_ID: z.string().optional().meta({
			title: "USAC API key ID",
			description: "API key identifier used to authenticate to USAC services.",
		}),
		USAC_API_SECRET_KEY: z.string().optional().meta({
			title: "USAC API secret key",
			description: "Secret API key used to authenticate to USAC services.",
		}),
		// Google Maps Platform key for the reference-geocoder ORACLE (`geocode-oracle/sdk/google-client.ts`).
		// Verification tooling only — nothing on the parse path reads this, and `@mailwoman/geocode-oracle` is
		// a private workspace precisely so it cannot become a runtime dependency of a published package.
		// BILLED PER REQUEST: the client caches for 30 days and paces at 60/minute by default for that reason.
		GOOGLE_MAPS_API_KEY: z.string().optional().meta({
			title: "Google Maps API key",
			description: "Google Maps Platform key used only by private reference-geocoder verification tooling.",
		}),
	})
	.meta({
		title: "Private environment configuration",
		description: "Secrets and credentials exposed through `$private`; never log their values.",
	})

// #endregion
