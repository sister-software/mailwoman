/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Mailwoman data root — the single, env-configurable home for every shard, model, anchor, and
 *   manifest the runtime + build tooling read. Centralized here (mirroring isp-nexus's
 *   `dataSourcePathBuilder`) so the lab `/mnt/playpen/...` default lives in EXACTLY ONE place instead
 *   of as a literal scattered across the codebase, and so consumers compose paths through
 *   {@link dataRootPath} rather than re-deriving the string. Going public, this is the only file that
 *   names the operator's filesystem layout; everything else reads `$MAILWOMAN_DATA_ROOT`.
 */

import { resolvePathBuilder } from "path-ts"

/**
 * The lab default data root — the ONE place this literal appears. Everything else builds on {@link dataRootPath} /
 * {@link mailwomanDataRoot}; override per-deployment with `$MAILWOMAN_DATA_ROOT`.
 */
const DEFAULT_MAILWOMAN_DATA_ROOT = "/mnt/playpen/mailwoman-data"

/** The Mailwoman data root: `$MAILWOMAN_DATA_ROOT` when set, else the lab default. */
export function mailwomanDataRoot(): string {
	return process.env["MAILWOMAN_DATA_ROOT"] ?? DEFAULT_MAILWOMAN_DATA_ROOT
}

/**
 * Build an absolute path under the data root, e.g. `dataRootPath("wof", "admin-global-priority.db")`. Reads the env on
 * each call, so a late `process.env` change (or a test) is honored.
 */
export function dataRootPath(...segments: string[]): string {
	return String(resolvePathBuilder(mailwomanDataRoot(), ...segments))
}

/**
 * The default WOF shard list the FTS backend probes when no single `--wof-db` is given: the global admin-priority shard
 * + the US postcode shard + the GeoNames-postal tail shard (#920 — postcode coverage for the namesake-tail locales
 * FI/CZ/SK/SI/DK/NO/HR/PL; country-aware routing in `pickShardForPlacetype` sends each postcode query to the shard that
 * claims its country). All under `dataRoot` (defaults to the configured {@link mailwomanDataRoot}; callers thread a
 * `--data-root` option through). A fresh array each call; callers filter with `existsSync`, so a deployment without the
 * tail shard degrades to the pre-#920 pair.
 */
export function wofShardPaths(dataRoot: string = mailwomanDataRoot()): [string, string, string, string, string] {
	return [
		String(resolvePathBuilder(dataRoot, "wof", "admin-global-priority.db")),
		String(resolvePathBuilder(dataRoot, "wof", "postalcode-us.db")),
		String(resolvePathBuilder(dataRoot, "wof", "postalcode-geonames-tail.db")),
		String(resolvePathBuilder(dataRoot, "wof", "postalcode-intl.db")),
		// #977: the NL PC6 full-postcode shard (CBS via PDOK; scripts/build-postalcode-nl-pc6.ts) — the
		// data the lookup's NL PC6 ladder ("1012 LG" → joined "1012LG" → 4-digit stem) resolves against.
		String(resolvePathBuilder(dataRoot, "wof", "postalcode-nl-pc6.db")),
	]
}
