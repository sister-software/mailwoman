import { z } from "zod"

import { DefaultMailwomanPaths } from "#env/paths"
import { blankAsAbsent } from "#env/utils"

/**
 * Non-secret operational config, exposed via `$public`. Add a key here to make it visible to the runtime; anything not
 * listed is stripped from `process.env` on parse.
 */
export const PublicEnvSchema = z

	// #region Node.js

	.object({
		// `.catch` (not `.default`) so an unknown value never throws — vitest sets NODE_ENV=test, CI may set others.
		NODE_ENV: z.enum(["development", "production", "test"]).catch("development").meta({
			title: "Node environment",
			description: "Runtime environment. Unknown values fall back to development.",
		}),
		CI: z.coerce.boolean().default(false).meta({
			title: "Continuous integration",
			description: "Whether the process is running in a continuous integration environment.",
		}),

		// #endregion

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

		// #region Who's on First

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

		// #endregion

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
		// ONNX intra-op thread cap. Deployment-shaped rather than code-shaped: the right value depends on how many
		// mailwoman processes share the host, which the library cannot know. See DEFAULT_INTRA_OP_THREADS.
		//
		MAILWOMAN_INTRA_OP_THREADS: blankAsAbsent(z.coerce.number().int().positive().optional()).meta({
			title: "ONNX intra-op threads",
			description: "Maximum ONNX Runtime intra-op worker threads for each Mailwoman process.",
		}),
		WOF_DATA_DIR: z.string().optional().meta({
			title: "Who's On First data directory",
			description: "Legacy Who's On First data-directory override retained for repository compatibility.",
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
		MAILWOMAN_LOG_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.log)).meta({
			title: "Log root",
			description: "Directory for persistent Mailwoman logs.",
		}),
		MAILWOMAN_TEMP_ROOT: blankAsAbsent(z.string().default(DefaultMailwomanPaths.temp)).meta({
			title: "Temporary root",
			description: "Directory for named temporary outputs and evaluation staging.",
		}),
		// Corpus source-fetch tools (`corpus/src/tools/fetch/*` — env knobs are now command flags; these remain for compat). Callers do their own numeric/boolean parsing on these,
		// so they stay raw strings — the schema only selects which keys surface, not how they're coerced.
		OUT_ROOT: z.string().optional().meta({
			title: "Corpus output root",
			description: "Compatibility override for the destination root used by corpus source fetchers.",
		}),
		NAD_MODE: z.string().optional().meta({
			title: "NAD fetch mode",
			description: "Compatibility override for the NAD fetch strategy: `featureserver` or `bulk`.",
		}),
		NAD_URL: z.string().optional().meta({
			title: "NAD bulk URL",
			description: "Compatibility override for the National Address Database bulk-download URL.",
		}),
		FS_END_OID: z.string().optional().meta({
			title: "NAD ending OBJECTID",
			description: "Compatibility override for the exclusive final NAD OBJECTID fetched from FeatureServer.",
		}),
		FS_START_OID: z.string().optional().meta({
			title: "NAD starting OBJECTID",
			description: "Compatibility override for the first NAD OBJECTID fetched from FeatureServer.",
		}),
		FS_CHUNK_SIZE: z.string().optional().meta({
			title: "NAD chunk size",
			description: "Compatibility override for NAD records written per output file.",
		}),
		FS_PAGE_SIZE: z.string().optional().meta({
			title: "NAD page size",
			description: "Compatibility override for NAD records requested per FeatureServer page.",
		}),
		FS_CONCURRENCY: z.string().optional().meta({
			title: "NAD fetch concurrency",
			description: "Compatibility override for parallel NAD FeatureServer page fetches.",
		}),
		SKIP_STATE_FIPS: z.string().optional().meta({
			title: "Skipped TIGER states",
			description: "Compatibility override for TIGER state FIPS codes to skip.",
		}),
		RATE_SLEEP: z.string().optional().meta({
			title: "TIGER download delay",
			description: "Compatibility override for the delay between TIGER downloads.",
		}),
		MAX_PARALLEL: z.string().optional().meta({
			title: "TIGER download concurrency",
			description: "Compatibility override for the maximum number of concurrent TIGER downloads.",
		}),
		DRY_RUN: z.string().optional().meta({
			title: "Corpus fetch dry run",
			description: "Compatibility toggle that prints planned corpus downloads without fetching them.",
		}),
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
		// Weights dev-linking + release copy (`neural-weights-*/scripts/link-dev-weights.ts`, `packages/release-kit/lib/weights/copy-weights.ts`).
		MAILWOMAN_DEV_MODEL: z.string().optional().meta({
			title: "Development model",
			description: "Path to the model artifact linked for local neural-weights development.",
		}),
		MAILWOMAN_DEV_TOKENIZER: z.string().optional().meta({
			title: "Development tokenizer",
			description: "Path to the tokenizer artifact linked for local neural-weights development.",
		}),
		MAILWOMAN_PUBLISH_MODEL: z.string().optional().meta({
			title: "Published model",
			description: "Model artifact selected for release copying and publication.",
		}),
		MAILWOMAN_PUBLISH_TOKENIZER: z.string().optional().meta({
			title: "Published tokenizer",
			description: "Tokenizer artifact selected for release copying and publication.",
		}),
		MAILWOMAN_SKIP_WEIGHTS_COPY: z.string().optional().meta({
			title: "Skip weights copy",
			description: "Compatibility toggle that skips copying neural weights during development or release preparation.",
		}),
		// Release-it publish flow (`packages/release-kit/lib/pack/publish-workspace.ts`). The OTP is a secret — see `$private`.
		MAILWOMAN_SKIP_WEIGHTS: z.string().optional().meta({
			title: "Skip release weights",
			description: "Release-flow toggle that omits neural weights from package publication.",
		}),
		/**
		 * Set to `0` to publish WITHOUT a sigstore provenance attestation. Provenance is otherwise on by default under
		 * GitHub Actions — this exists so a release blocked by a sigstore or registry outage can still ship.
		 */
		MAILWOMAN_NPM_PROVENANCE: z.string().optional().meta({
			title: "npm provenance",
			description:
				"Set to `0` to publish without a Sigstore provenance attestation; otherwise provenance is enabled in GitHub Actions.",
		}),
		/**
		 * Set by GitHub Actions itself. npm can only mint a provenance attestation from a CI provider it supports, so this
		 * is the predicate for `--provenance` rather than the generic {@link CI} flag.
		 */
		GITHUB_ACTIONS: z.coerce.boolean().default(false).meta({
			title: "GitHub Actions",
			description: "Whether the process is running under GitHub Actions; used to determine npm provenance support.",
		}),
		RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: z.string().optional().meta({
			title: "Release workspace path",
			description: "Workspace path override consumed by the release-it workspaces publish flow.",
		}),
		RELEASE_IT_WORKSPACES_TAG: z.string().optional().meta({
			title: "Release dist-tag",
			description: "npm distribution tag override consumed by the release-it workspaces publish flow.",
		}),
		RELEASE_IT_WORKSPACES_ACCESS: z.string().optional().meta({
			title: "Release package access",
			description: "npm package access override consumed by the release-it workspaces publish flow.",
		}),
		RELEASE_IT_WORKSPACES_DRY_RUN: z.string().optional().meta({
			title: "Release dry run",
			description: "Dry-run override consumed by the release-it workspaces publish flow.",
		}),
		// Demo artifact staging (`docs/plugins/demo-assets/artifacts.ts`) + docs driver.
		PLAYPEN_WOF_ADMIN_DB: z.string().optional().meta({
			title: "Playpen WOF admin database",
			description: "Who's On First admin database staged for demo and documentation artifacts.",
		}),
		PLAYPEN_WOF_POSTCODE_DB: z.string().optional().meta({
			title: "Playpen WOF postcode database",
			description: "Who's On First postcode database staged for demo and documentation artifacts.",
		}),
		SLIM_COUNTRIES: z.string().optional().meta({
			title: "Slim demo countries",
			description: "Country selection used when building slim demo artifacts.",
		}),
		MAILWOMAN_DOCS_URL: z.string().optional().meta({
			title: "Documentation URL",
			description: "Base URL used by documentation and demo tooling.",
		}),
		/**
		 * A signed commercial license key (`mwl1.<payload>.<signature>`, Ed25519 over the payload, verified offline against
		 * the public keys `@mailwoman/core/license` ships). Its presence changes what `mailwoman doctor` reports about the
		 * license that applies to this installation; it never changes what the runtime does. Absent means the AGPL-3.0-only
		 * branch applies. Public in the sense that it is a signed assertion, not a secret, but the doctor prints the
		 * licensee and expiry rather than the token.
		 */
		MAILWOMAN_LICENSE_KEY: blankAsAbsent(z.string().min(1).optional()).meta({
			title: "Commercial license key",
			description:
				"Signed commercial license assertion used by `mailwoman doctor`; it does not change runtime behavior.",
		}),
		/**
		 * The license worker's origin (`https://license.mailwoman.ai` when unset), for `mailwoman license refresh` and the
		 * online per-license status. Pointed at a sandbox deploy or a test stub.
		 */
		MAILWOMAN_LICENSE_URL: blankAsAbsent(z.string().min(1).optional()).meta({
			title: "License service URL",
			description: "License-service origin used by license refresh and online status checks.",
		}),
		// Eval scripts (`scripts/eval/*`) — diagnostic toggles + DB/probe overrides.
		MAILWOMAN_WOF_HOT_DB: z.string().optional().meta({
			title: "Evaluation WOF hot database",
			description: "Who's On First database override used by evaluation tooling.",
		}),
		/**
		 * Override the admin gazetteer used by the default-country test panel.
		 */
		MAILWOMAN_WOF_GLOBAL_DB: z.string().optional().meta({
			title: "Evaluation global admin database",
			description: "Admin gazetteer override used by the default-country evaluation panel.",
		}),
		/**
		 * Deployed demo URL for the docs e2e suite (skips the local build+serve implementation).
		 */
		MAILWOMAN_DEMO_URL: z.string().optional().meta({
			title: "Deployed demo URL",
			description: "Deployed demo URL used by the documentation end-to-end suite instead of a local build.",
		}),
		/**
		 * Override the ONNX model exercised by the neural test suites.
		 */
		MAILWOMAN_TEST_ONNX_MODEL: z.string().optional().meta({
			title: "Test ONNX model",
			description: "ONNX model override exercised by neural test suites.",
		}),
		/**
		 * Override the ONNX model exercised by the capability check.
		 */
		MAILWOMAN_CAPABILITY_ONNX_MODEL: z.string().optional().meta({
			title: "Capability-check ONNX model",
			description: "ONNX model override exercised by the capability check.",
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
		/**
		 * Selects the with-data half of `mailwoman/test/dropin-cold-start.test.ts` — a real `mailwoman data pull candidate`
		 * (~1.65 GB) plus booting all three drop-in servers against it. Unset in CI; the always-on half (missing-data +
		 * libpostal's zero-data boot) downloads nothing and needs no guard.
		 */
		MAILWOMAN_COLD_START_FULL: z.string().optional().meta({
			title: "Full cold-start test",
			description: "Enables the with-data cold-start suite that pulls candidate data and boots all drop-in servers.",
		}),
		/**
		 * Reuse an already-populated data root for the conditional cold-start suite above instead of pulling candidate.db
		 * fresh into a throwaway temp dir — avoids a redundant ~1.65 GB re-download across repeated local runs.
		 */
		MAILWOMAN_COLD_START_DATA_ROOT: z.string().optional().meta({
			title: "Cold-start data root",
			description: "Existing populated data root reused by the conditional full cold-start suite.",
		}),
		MW_DUMP_REGRESSIONS: z.string().optional().meta({
			title: "Dump evaluation regressions",
			description: "Set to enable row-level regression dumps from evaluation harnesses that support it.",
		}),
		PROBE_N: z.string().optional().meta({
			title: "Evaluation probe size",
			description: "Repository evaluation probe-size override retained for diagnostic tooling.",
		}),
		DEBUG: z.string().optional().meta({
			title: "Debug mode",
			description: "Repository-wide debug toggle consumed by development and diagnostic tooling.",
		}),
		// The informal-standard color kill switch (no-color.org). chalk/Ink honor it on their own; declared here because the debug view's map pane emits raw SGR and must consult it itself — the schema strips unlisted vars.
		NO_COLOR: z.string().optional().meta({
			title: "Disable color",
			description: "Disables ANSI color output, following the informal NO_COLOR convention.",
		}),
	})
	.meta({
		title: "Public environment configuration",
		description: "Non-secret operational configuration exposed through `$public`.",
	})
