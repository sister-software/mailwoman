import { z } from "zod"

/**
 * Non-secret operational config, exposed via `$public`. Add a key here to make it visible to the runtime; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PublicEnvSchema = z.object({
	// `.catch` (not `.default`) so an unknown value never throws — vitest sets NODE_ENV=test, CI may set others.
	NODE_ENV: z.enum(["development", "production", "test"]).catch("development"),
	CI: z.coerce.boolean().default(false),

	// Gazetteer / resolver database paths. CLI flags (`--resolve-db`, …) override these at the call site.
	MAILWOMAN_WOF_DB: z.string().optional(),
	MAILWOMAN_WOF_ADMIN_DB: z.string().optional(),
	MAILWOMAN_WOF_POLYGONS_DB: z.string().optional(),
	MAILWOMAN_CANDIDATE_DB: z.string().optional(),
	MAILWOMAN_POSTAL_CITY_ALIAS_DB: z.string().optional(),
	MAILWOMAN_FST_BIN: z.string().optional(),
	MAILWOMAN_MODEL_CARD: z.string().optional(),
	WOF_DATA_DIR: z.string().optional(),

	// Geocode server batch tuning (`GeocodeRouter`).
	MAILWOMAN_BATCH_CONCURRENCY: z.coerce.number().int().positive().default(8),
	MAILWOMAN_BATCH_MAX: z.coerce.number().int().positive().default(1000),
})

/**
 * Secrets and credentials, exposed via `$private`. Never log these. Add a key here to make it available; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PrivateEnvSchema = z.object({
	HF_BUCKET_URI: z.string().optional(),
	HF_ORG_NAME: z.string().optional(),
	HF_BUCKET_NAME: z.string().optional(),
	HF_BUCKET_RESOLVE_URL: z.url().optional(),
	HF_TOKEN: z.string().min(1, "HF_TOKEN required").optional(),

	CF_AUTH_TOKEN: z.string().optional(),
	GEOCODE_EARTH_API_KEY: z.string().optional(),

	// R2/S3 upload credentials for `tiles publish` (rclone `:s3:` remote).
	RCLONE_S3_ENDPOINT: z.string().optional(),
	RCLONE_S3_ACCESS_KEY_ID: z.string().optional(),
	RCLONE_S3_SECRET_ACCESS_KEY: z.string().optional(),
})
