import { z } from "zod"

import { DefaultMailwomanPaths } from "#env/paths"

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
	/**
	 * Operator locale override used when a request supplies no locale. Safe to expose in diagnostics.
	 */
	MW_LOCALE: z.string().min(1).optional(),

	// Gazetteer / resolver database paths. CLI flags (`--resolve-db`, …) override these at the call site.
	MAILWOMAN_WOF_DB: z.string().optional(),
	MAILWOMAN_WOF_ADMIN_DB: z.string().optional(),
	MAILWOMAN_WOF_POLYGONS_DB: z.string().optional(),
	MAILWOMAN_CANDIDATE_DB: z.string().optional(),
	MAILWOMAN_POSTAL_CITY_ALIAS_DB: z.string().optional(),
	MAILWOMAN_FST_BIN: z.string().optional(),
	MAILWOMAN_MODEL_CARD: z.string().optional(),
	MAILWOMAN_COARSE_PLACER_DIR: z.string().optional(),
	// PMTiles archive for the geocode --debug map pane; --tiles outranks it at the call site.
	MAILWOMAN_TILES: z.string().optional(),

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
	// threads (see `mailwoman/geocode-stream.ts`) are the only change that moves this in Node.
	// Receipts: `docs/engineering/reference/performance.mdx`.
	MAILWOMAN_BATCH_MAX: blankAsAbsent(z.coerce.number().int().positive().default(1000)),

	// Platform-native application directories. Environment values override these defaults.
	//
	// A bare `.default()` fires only on `undefined`, so a present-but-empty variable passes validation intact.
	MAILWOMAN_DATA_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.data)),
	MAILWOMAN_CONFIG_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.config)),
	MAILWOMAN_CACHE_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.cache)),
	MAILWOMAN_LOG_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.log)),
	MAILWOMAN_TEMP_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.temp)),

	// Corpus source-fetch tools (`corpus/src/tools/fetch/*` — env knobs are now command flags; these remain for compat). Callers do their own numeric/boolean parsing on these,
	// so they stay raw strings — the schema only selects which keys surface, not how they're coerced.
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

	// Weights dev-linking + release copy (`neural-weights-*/scripts/link-dev-weights.ts`, `packages/release-kit/lib/weights/copy-weights.ts`).
	MAILWOMAN_DEV_MODEL: z.string().optional(),
	MAILWOMAN_DEV_TOKENIZER: z.string().optional(),
	MAILWOMAN_PUBLISH_MODEL: z.string().optional(),
	MAILWOMAN_PUBLISH_TOKENIZER: z.string().optional(),
	MAILWOMAN_SKIP_WEIGHTS_COPY: z.string().optional(),

	// Release-it publish flow (`packages/release-kit/lib/pack/publish-workspace.ts`). The OTP is a secret — see `$private`.
	MAILWOMAN_SKIP_WEIGHTS: z.string().optional(),
	/**
	 * Set to `0` to publish WITHOUT a sigstore provenance attestation. Provenance is otherwise on by default under GitHub
	 * Actions — this exists so a release blocked by a sigstore or registry outage can still ship.
	 */
	MAILWOMAN_NPM_PROVENANCE: z.string().optional(),
	/**
	 * Set by GitHub Actions itself. npm can only mint a provenance attestation from a CI provider it supports, so this is
	 * the predicate for `--provenance` rather than the generic {@link CI} flag.
	 */
	GITHUB_ACTIONS: z.coerce.boolean().default(false),
	RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: z.string().optional(),
	RELEASE_IT_WORKSPACES_TAG: z.string().optional(),
	RELEASE_IT_WORKSPACES_ACCESS: z.string().optional(),
	RELEASE_IT_WORKSPACES_DRY_RUN: z.string().optional(),

	// Demo artifact staging (`docs/plugins/demo-assets/artifacts.ts`) + docs driver.
	PLAYPEN_WOF_ADMIN_DB: z.string().optional(),
	PLAYPEN_WOF_POSTCODE_DB: z.string().optional(),
	SLIM_COUNTRIES: z.string().optional(),
	MAILWOMAN_DOCS_URL: z.string().optional(),
	/**
	 * A signed commercial license key (`mwl1.<payload>.<signature>`, Ed25519 over the payload, verified offline against
	 * the public keys `@mailwoman/core/license` ships). Its presence changes what `mailwoman doctor` reports about the
	 * license that applies to this installation; it never changes what the runtime does. Absent means the AGPL-3.0-only
	 * branch applies. Public in the sense that it is a signed assertion, not a secret, but the doctor prints the licensee
	 * and expiry rather than the token.
	 */
	MAILWOMAN_LICENSE_KEY: blankAsAbsent(z.string().min(1).optional()),
	/**
	 * The license worker's origin (`https://license.mailwoman.ai` when unset), for `mailwoman license refresh` and the
	 * online per-license status. Pointed at a sandbox deploy or a test stub.
	 */
	MAILWOMAN_LICENSE_URL: blankAsAbsent(z.string().min(1).optional()),

	// Eval scripts (`scripts/eval/*`) — diagnostic toggles + DB/probe overrides.
	MAILWOMAN_WOF_HOT_DB: z.string().optional(),
	/**
	 * Override the admin gazetteer used by the default-country test panel.
	 */
	MAILWOMAN_WOF_GLOBAL_DB: z.string().optional(),
	/**
	 * Deployed demo URL for the docs e2e suite (skips the local build+serve implementation).
	 */
	MAILWOMAN_DEMO_URL: z.string().optional(),
	/**
	 * Override the ONNX model exercised by the neural test suites.
	 */
	MAILWOMAN_TEST_ONNX_MODEL: z.string().optional(),
	/**
	 * Override the ONNX model exercised by the capability check.
	 */
	MAILWOMAN_CAPABILITY_ONNX_MODEL: z.string().optional(),
	MAILWOMAN_DIAG_INTERP: z.string().optional(),
	MAILWOMAN_DUMP_MISS_TAG: z.string().optional(),
	MAILWOMAN_WORD_CONSISTENCY: z.string().optional(),
	/**
	 * PIX1 whole-edge parent bias (#46) — the δ applied to the PARENT window of a placetype-pair hit, over the child
	 * tag's allowed parents in `containmentFor(system)`. UNSET (the default) = child-only, byte-identical to every
	 * pre-#46 build.
	 *
	 * A bar-conditional toggle, not a shipped knob: the mechanism stays off until the four bars in
	 * `docs/superpowers/plans/2026-08-04-pix1-whole-edge-preregistration.md` clear, and this is how the ON leg of B-1's
	 * ON-vs-OFF comparison is driven through `mailwoman eval gauntlet` without a code edit between the two runs.
	 */
	MAILWOMAN_PAIR_PARENT_DELTA: blankAsAbsent(z.coerce.number().optional()),
	/**
	 * Selects the with-data half of `mailwoman/test/dropin-cold-start.test.ts` — a real `mailwoman data pull candidate`
	 * (~1.65 GB) plus booting all three drop-in servers against it. Unset in CI; the always-on half (missing-data +
	 * libpostal's zero-data boot) downloads nothing and needs no guard.
	 */
	MAILWOMAN_COLD_START_FULL: z.string().optional(),
	/**
	 * Reuse an already-populated data root for the conditional cold-start suite above instead of pulling candidate.db
	 * fresh into a throwaway temp dir — avoids a redundant ~1.65 GB re-download across repeated local runs.
	 */
	MAILWOMAN_COLD_START_DATA_ROOT: z.string().optional(),
	MW_DUMP_REGRESSIONS: z.string().optional(),
	PROBE_N: z.string().optional(),
	DEBUG: z.string().optional(),
	// The informal-standard color kill switch (no-color.org). chalk/Ink honor it on their own; declared here because the debug view's map pane emits raw SGR and must consult it itself — the schema strips unlisted vars.
	NO_COLOR: z.string().optional(),
})

/**
 * Secrets and credentials, exposed via `$private`. Never log these. Add a key here to make it available; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PrivateEnvSchema = z.object({
	// #region Hugging Face

	HF_BUCKET_URI: z.string().optional(),
	HF_ORG_NAME: z.string().optional(),
	HF_BUCKET_NAME: z.string().optional(),
	HF_BUCKET_RESOLVE_URL: z.url().optional(),
	HF_TOKEN: z.string().min(1, "HF_TOKEN required").optional(),

	// #endregion

	//#region Stripe

	/**
	 * The test-mode secret key (`sk_test_…`): `mwops shop … --mode test` provisions the sandbox twins of the shop's
	 * Stripe objects with it and refuses any other prefix.
	 */
	MAILWOMAN_STRIPE_SECRET_KEY: z.string().optional(),
	/**
	 * The live-mode secret key (`sk_live_…`), held apart from the test one so a live write is a deliberate act: `mwops
	 * shop … --mode live` reads this and refuses any other prefix.
	 */
	MAILWOMAN_STRIPE_LIVE_SECRET_KEY: z.string().optional(),

	// #endregion

	CF_AUTH_TOKEN: z.string().optional(),
	GEOCODE_EARTH_API_KEY: z.string().optional(),

	// UK EPC bulk-download API token (en-GB acquisition — EPC certificates, UPRN-joinable).
	UK_EPC_TOKEN: z.string().optional(),

	/**
	 * Per-run secret salting the published case identifiers of a controlled premise-linkage evaluation (`mailwoman eval
	 * premise-linkage`). A secret rather than config: two reports salted alike can be joined row for row into a longer
	 * record of the same premises, which is the linkage the identifier exists to prevent.
	 */
	MAILWOMAN_PREMISE_LINKAGE_SALT: z.string().optional(),

	// LLM API keys for the corpus golden-expansion tooling.
	DEEPSEEK_API_KEY: z.string().optional(),
	ANTHROPIC_API_KEY: z.string().optional(),

	// R2/S3 upload credentials for `tiles publish` (rclone `:s3:` remote).
	RCLONE_S3_ENDPOINT: z.string().optional(),
	RCLONE_S3_ACCESS_KEY_ID: z.string().optional(),
	RCLONE_S3_SECRET_ACCESS_KEY: z.string().optional(),

	// OpenAddresses batch-download API token (`corpus/src/tools/fetch/openaddresses.ts`).
	OA_BATCH_TOKEN: z.string().optional(),

	// npm 2FA OTP for the release publish flow (`packages/release-kit/lib/pack/publish-workspace.ts`).
	RELEASE_IT_WORKSPACES_OTP: z.string().optional(),

	// FCC Broadband Map (BDC) public-API credentials (`bdc/sdk/client.ts`) — username + hash_value header auth.
	FCC_MAP_USERNAME: z.string().optional(),
	FCC_MAP_API_KEY: z.string().optional(),

	// SEC EDGAR fair-access User-Agent (`filer/sdk/sec-client.ts`) — "Company Name AdminContact@domain.com".
	SEC_EDGAR_USER_AGENT: z.string().optional(),
	/**
	 * Descriptive User-Agent for the FCC CORES lookup (`filer/sdk/cores-client.ts`). Optional in a way
	 * `SEC_EDGAR_USER_AGENT` is not: SEC 403s a request that fails to identify itself, FCC does not. Falls back to
	 * `SEC_EDGAR_USER_AGENT` — the same contact address — when unset.
	 */
	FCC_CORES_USER_AGENT: z.string().optional(),

	USAC_API_KEY_ID: z.string().optional(),
	USAC_API_SECRET_KEY: z.string().optional(),

	// Google Maps Platform key for the reference-geocoder ORACLE (`geocode-oracle/sdk/google-client.ts`).
	// Verification tooling only — nothing on the parse path reads this, and `@mailwoman/geocode-oracle` is
	// a private workspace precisely so it cannot become a runtime dependency of a published package.
	// BILLED PER REQUEST: the client caches for 30 days and paces at 60/minute by default for that reason.
	GOOGLE_MAPS_API_KEY: z.string().optional(),
})
