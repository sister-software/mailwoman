/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The worker's tests run under the Workers runtime through Miniflare, with the sandbox environment's bindings and a
 *   fresh D1 per test file. Secrets are placeholders here; a `wrangler dev` run reads `.dev.vars` instead. The root
 *   vitest sweep excludes this workspace, and CI runs it as its own step.
 */

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

// The migrations are read here, on the Node side, and handed to the runtime as a binding the tests apply.
// Anchored on this file, not the working directory: knip and the root tooling load this config from the repo root.
const migrations = await readD1Migrations(`${import.meta.dirname}/migrations`)

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml", environment: "sandbox" },
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
