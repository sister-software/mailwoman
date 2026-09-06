/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolve the `wof-hot.db` used by the demo-cascade smoke test.
 *
 *   `promotion-eval.ts`, smoke module, and provenance report must use the same lookup order. The database exists only in
 *   a staged demo release because the live demo no longer uses it as its points source. The smoke test skips when the
 *   file is absent (#524), so provenance must report the exact path that the test checks.
 *
 *   Keep this module limited to environment and path handling. The provenance report imports it without loading the
 *   neural or resolver modules.
 */

import { tempRootPath } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/resolver-wof-wasm/env"
import { join } from "path-ts"

/**
 * The default demo stage directory. This is a staged release path rather than a data-root artifact.
 */
export function wofHotStageDir(): string {
	return String(tempRootPath("v440-stage", "en-us", "v4.4.0"))
}

/**
 * Resolve the `wof-hot.db` path: `$MAILWOMAN_WOF_HOT_DB` when set and non-empty, then the staged database.
 *
 * `||` on purpose — an empty env var means unset, never "resolve against the empty string".
 */
export function resolveWOFHotDB(stageDir?: string): string {
	return $public.MAILWOMAN_WOF_HOT_DB || join(stageDir ?? wofHotStageDir(), "wof-hot.db")
}
