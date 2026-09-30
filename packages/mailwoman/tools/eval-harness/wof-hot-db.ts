/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Resolve the `wof-hot.db` used by the demo-cascade smoke test.
 *
 *   `promotion-eval.ts`, the smoke module and the provenance report must use the same lookup order. The database
 *   exists only in a staged demo release. The smoke test skips when the file is absent, so provenance must report
 *   the exact path that the test checks.
 *
 *   Keep this module limited to environment and path handling. The provenance report imports it without loading the
 *   neural or resolver modules.
 */

import { tempRootPathBuilder } from "@mailwoman/core/data-root"
import { $public } from "@mailwoman/resolver-wof-wasm/env"
import { PathBuilder, type PathBuilderLike } from "path-ts"

/**
 * The default demo stage directory.
 *
 * This is a staged release path rather than a data-root artifact.
 */
export function wofHotStageDir(): PathBuilder {
	return tempRootPathBuilder("v440-stage", "en-us", "v4.4.0")
}

/**
 * Resolve the `wof-hot.db` path: `$MAILWOMAN_WOF_HOT_DB` when set and non-empty, then the staged database.
 *
 * `||` on purpose.
 * An empty env var means unset, never "resolve against the empty string".
 *
 * The answer is a string because the environment variable, the other source, is one.
 */
export function resolveWOFHotDB(stageDir?: PathBuilderLike): string {
	return $public.MAILWOMAN_WOF_HOT_DB || PathBuilder.from(stageDir ?? wofHotStageDir())("wof-hot.db").toString()
}
