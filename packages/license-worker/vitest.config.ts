/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's tests run under the Workers runtime through Miniflare, with the sandbox config's bindings and a
 *   fresh D1 per test file. Secrets are placeholders here.
 *   A `wrangler dev` run reads `.dev.vars` instead.
 *   The root Vitest sweep excludes this workspace. CI runs it as its own step.
 */

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// Node reads the migrations here and passes them to the runtime as a binding that tests apply.
// Resolve the path from this file rather than the working directory. knip
// and the root tooling load this config from the repo root.
const migrations = await readD1Migrations(`${import.meta.dirname}/migrations`)

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.sandbox.toml" },
			miniflare: {
				bindings: {
					STRIPE_SECRET_KEY: "sk_test_placeholder",
					STRIPE_WEBHOOK_SECRET: "whsec_test_placeholder",
					LICENSE_SIGNING_KEY_PEM: "",
					EMAIL_API_KEY: "re_test_placeholder",
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
	test: {
		include: ["test/**/*.test.ts"],
	},
})
