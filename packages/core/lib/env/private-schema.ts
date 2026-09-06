/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Schema definitions for the private environment, exposed via `$private`.
 */
import { z } from "zod"

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
		/**
		 * Per-run secret salting the published case identifiers of a controlled premise-linkage evaluation (`mailwoman eval
		 * premise-linkage`). A secret rather than config: two reports salted alike can be joined row for row into a longer
		 * record of the same premises, which is the linkage the identifier exists to prevent.
		 */
		MAILWOMAN_PREMISE_LINKAGE_SALT: z.string().optional().meta({
			title: "Premise-linkage salt",
			description: "Per-run secret used to salt published case identifiers in controlled premise-linkage evaluations.",
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
		RELEASE_IT_WORKSPACES_OTP: z.string().optional().meta({
			title: "npm one-time password",
			description: "npm two-factor authentication code used by the release publish flow.",
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
