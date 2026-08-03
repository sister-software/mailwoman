import { z } from "zod"

/**
 * Wrap a coerced schema so a BLANK value means the same as an absent one.
 *
 * A shell `export FOO=`, an unset Docker/CI `${VAR}` interpolation and a compose file with a missing key all arrive as
 * an empty string rather than as nothing. `z.coerce.number()` turns that into `0`, which any `.positive()` or `.min()`
 * then rejects — so the process dies at import instead of falling back to its default, and the message points at a
 * variable the operator believes they never set.
 *
 * The `.optional()`/`.default()` must be applied to `inner` BEFORE it reaches here: the outer value is present, so an
 * outer `.optional()` never fires — `inner` is what receives the `undefined` this produces.
 */
function blankAsAbsent<T extends z.ZodType>(inner: T) {
	return z.preprocess((v) => (v === "" ? undefined : v), inner)
}

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
	MAILWOMAN_COARSE_PLACER_DIR: z.string().optional(),

	// ONNX intra-op thread cap. Deployment-shaped rather than code-shaped: the right value depends on how many
	// mailwoman processes share the host, which the library cannot know. See DEFAULT_INTRA_OP_THREADS.
	//
	MAILWOMAN_INTRA_OP_THREADS: blankAsAbsent(z.coerce.number().int().positive().optional()),
	WOF_DATA_DIR: z.string().optional(),

	// Geocode server batch row cap (`POST /v1/batch`).
	//
	// `MAILWOMAN_BATCH_CONCURRENCY` was REMOVED 2026-07-16 — it was inert. In-process concurrency
	// cannot overlap a geocode: `onnxruntime-node`'s `session.run()` blocks the JS thread instead of
	// releasing to the libuv pool, and `node:sqlite` reads are synchronous. Measured 1.00x flat from
	// 1→16 workers on both parse and full geocode. Don't reintroduce it without re-measuring; worker
	// threads (see `mailwoman/geocode-stream.ts`) are the only lever that moves this in Node.
	// Receipts: `docs/engineering/reference/performance.mdx`.
	MAILWOMAN_BATCH_MAX: blankAsAbsent(z.coerce.number().int().positive().default(1000)),

	// The gazetteer/model data root (`core/utils/data-root.ts`, `scripts/copy-weights.ts`).
	MAILWOMAN_DATA_ROOT: z.string().optional(),

	// Corpus source-fetch tools (`corpus/src/tools/fetch/*` — env knobs are now command flags; these remain for compat). Callers do their own numeric/boolean parsing on these,
	// so they stay raw strings — the schema only gates which keys surface, not how they're coerced.
	OUT_ROOT: z.string().optional(),
	NAD_MODE: z.string().optional(),
	NAD_URL: z.string().optional(),
	FS_END_OID: z.string().optional(),
	FS_START_OID: z.string().optional(),
	FS_CHUNK_SIZE: z.string().optional(),
	FS_PAGE_SIZE: z.string().optional(),
	FS_CONCURRENCY: z.string().optional(),
	SKIP_STATE_FIPS: z.string().optional(),
	RATE_SLEEP: z.string().optional(),
	MAX_PARALLEL: z.string().optional(),
	DRY_RUN: z.string().optional(),

	// Python training driver (`corpus-python/scripts/train_with_resume.ts`) + build resume (`corpus/src/build.ts`).
	MAX_ATTEMPTS: z.string().optional(),
	LOG: z.string().optional(),
	CONFIG: z.string().optional(),
	PYTHON: z.string().optional(),
	MAILWOMAN_RESUME: z.string().optional(),

	// Weights dev-linking + release copy (`neural-weights-*/scripts/link-dev-weights.ts`, `scripts/copy-weights.ts`).
	MAILWOMAN_DEV_MODEL: z.string().optional(),
	MAILWOMAN_DEV_TOKENIZER: z.string().optional(),
	MAILWOMAN_PUBLISH_MODEL: z.string().optional(),
	MAILWOMAN_PUBLISH_TOKENIZER: z.string().optional(),
	MAILWOMAN_SKIP_WEIGHTS_COPY: z.string().optional(),

	// Release-it publish flow (`scripts/publish-workspace.ts`). The OTP is a secret — see `$private`.
	MAILWOMAN_SKIP_WEIGHTS: z.string().optional(),
	MAILWOMAN_NPM_PROVENANCE: z.string().optional(),
	RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: z.string().optional(),
	RELEASE_IT_WORKSPACES_TAG: z.string().optional(),
	RELEASE_IT_WORKSPACES_ACCESS: z.string().optional(),
	RELEASE_IT_WORKSPACES_DRY_RUN: z.string().optional(),

	// Demo resolver (`docs/plugins/demo-assets/resolve.ts`) + docs driver.
	PLAYPEN_WOF_ADMIN_DB: z.string().optional(),
	PLAYPEN_WOF_POSTCODE_DB: z.string().optional(),
	SLIM_COUNTRIES: z.string().optional(),
	MAILWOMAN_DOCS_URL: z.string().optional(),

	// Eval scripts (`scripts/eval/*`) — diagnostic toggles + DB/probe overrides.
	MAILWOMAN_WOF_HOT_DB: z.string().optional(),
	/**
	 * Override the admin gazetteer used by the default-country test panel.
	 */
	MAILWOMAN_WOF_GLOBAL_DB: z.string().optional(),
	/**
	 * Deployed demo URL for the docs e2e suite (skips the local build+serve machinery).
	 */
	MAILWOMAN_DEMO_URL: z.string().optional(),
	/**
	 * Override the ONNX model exercised by the neural test suites.
	 */
	MAILWOMAN_TEST_ONNX_MODEL: z.string().optional(),
	/**
	 * Override the ONNX model exercised by the capability gate.
	 */
	MAILWOMAN_CAPABILITY_ONNX_MODEL: z.string().optional(),
	MAILWOMAN_DIAG_INTERP: z.string().optional(),
	MAILWOMAN_DUMP_MISS_TAG: z.string().optional(),
	MAILWOMAN_WORD_CONSISTENCY: z.string().optional(),
	/**
	 * Gates the with-data half of `mailwoman/test/dropin-cold-start.test.ts` — a real `mailwoman data pull candidate`
	 * (~1.65 GB) plus booting all three drop-in servers against it. Unset in CI; the always-on half (missing-data +
	 * libpostal's zero-data boot) downloads nothing and needs no guard.
	 */
	MAILWOMAN_COLD_START_FULL: z.string().optional(),
	/**
	 * Reuse an already-populated data root for the gated cold-start suite above instead of pulling candidate.db fresh
	 * into a throwaway temp dir — avoids a redundant ~1.65 GB re-download across repeated local runs.
	 */
	MAILWOMAN_COLD_START_DATA_ROOT: z.string().optional(),
	MW_DUMP_REGRESSIONS: z.string().optional(),
	PROBE_N: z.string().optional(),
	DEBUG: z.string().optional(),
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

	// UK EPC bulk-download API token (en-GB acquisition — EPC certificates, UPRN-joinable).
	UK_EPC_TOKEN: z.string().optional(),

	// LLM API keys for the corpus golden-expansion tooling.
	DEEPSEEK_API_KEY: z.string().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),

	// R2/S3 upload credentials for `tiles publish` (rclone `:s3:` remote).
	RCLONE_S3_ENDPOINT: z.string().optional(),
	RCLONE_S3_ACCESS_KEY_ID: z.string().optional(),
	RCLONE_S3_SECRET_ACCESS_KEY: z.string().optional(),

	// OpenAddresses batch-download API token (`corpus/src/tools/fetch/openaddresses.ts`).
	OA_BATCH_TOKEN: z.string().optional(),

	// npm 2FA OTP for the release publish flow (`scripts/publish-workspace.ts`).
	RELEASE_IT_WORKSPACES_OTP: z.string().optional(),

	// FCC Broadband Map (BDC) public-API credentials (`bdc/sdk/client.ts`) — username + hash_value header auth.
	FCC_MAP_USERNAME: z.string().optional(),
	FCC_MAP_API_KEY: z.string().optional(),

	// SEC EDGAR fair-access User-Agent (`filer/sdk/sec-client.ts`) — "Company Name AdminContact@domain.com".
	SEC_EDGAR_USER_AGENT: z.string().optional(),
})
