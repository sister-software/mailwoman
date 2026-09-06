/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape of `env` inside the test isolate: the worker's bindings plus the migrations the pool hands in from
 *   vitest.config.ts. Declared once so no test re-asserts it with a cast.
 */

import type { LicenseWorkerBindings } from "@mailwoman/license-worker/env"
import type { D1Migration } from "cloudflare:test"

declare global {
	namespace Cloudflare {
		interface Env extends LicenseWorkerBindings {
			TEST_MIGRATIONS: D1Migration[]
		}
	}
}
