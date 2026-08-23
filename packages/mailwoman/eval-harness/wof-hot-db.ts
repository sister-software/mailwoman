/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Where `wof-hot.db` lives — the ONE resolution ladder for the demo-stage sidecar.
 *
 *   Three call sites carried private copies of this ladder (the promotion gate's demo-cascade leg, the smoke module's
 *   own default, and the provenance report), and two already disagreed on the empty-string case (`||` vs `??`). The
 *   artifact is easy to misreport: it was RETIRED as the demo's points source on 2026-06-20 — the admin tier
 *   byte-range-resolves instead — so it exists only where a demo release was STAGED, and the gate's whole-stack lens
 *   SKIPS without it (#524). A reader asking "does wof-hot.db exist" needs the path the gate will actually probe, not
 *   a plausible one.
 *
 *   This module stays a LEAF — env + path only. It is imported by the provenance report, which must not drag the
 *   neural/resolver stack in behind a file stat.
 */

import { join } from "node:path"

import { $public } from "@mailwoman/core/env"
import { tempRootPath } from "@mailwoman/core/utils"

/**
 * The demo stage directory the ladder defaults under — the last STAGED demo release, not a data-root artifact. A new
 * demo stage moves this constant with it.
 */
export function wofHotStageDir(): string {
	return String(tempRootPath("v440-stage", "en-us", "v4.4.0"))
}

/**
 * Resolve the `wof-hot.db` path: `$MAILWOMAN_WOF_HOT_DB` when set and non-empty, else the staged sidecar.
 *
 * `||` on purpose — an empty env var means unset, never "resolve against the empty string".
 */
export function resolveWOFHotDB(stageDir?: string): string {
	return $public.MAILWOMAN_WOF_HOT_DB || join(stageDir ?? wofHotStageDir(), "wof-hot.db")
}
