/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shape of `env` and `exports` inside the test isolate: the Worker's bindings plus the fixture vitest.config.ts
 *   hands in, and the main module's entry point, so `exports.default.findPlace` is typed. Declared once so no test
 *   re-asserts it with a cast.
 */

import type { GazetteerWorkerEnv } from "@mailwoman/gazetteer-worker"

declare global {
	namespace Cloudflare {
		interface Env extends GazetteerWorkerEnv {
			/**
			 * The fixture candidate database, base64-encoded.
			 */
			CANDIDATE_FIXTURE_BASE64: string
		}

		interface GlobalProps {
			mainModule: typeof import("@mailwoman/gazetteer-worker")
		}
	}
}
