/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Multi-shard support for `WOFSqlitePlaceLookup` — opens multiple WOF SQLite distributions on one
 *   connection via `ATTACH DATABASE`, and routes queries to the right shard based on placetype.
 *
 *   ## The FTS5 syntax rule that drove this design
 *
 *   The naive `SELECT … FROM pc.place_search WHERE pc.place_search MATCH ?` fails — SQLite parses the
 *   schema-qualified table on the left of MATCH as "column place_search of table pc". Discovered in
 *   the spike at PR review time; documented as `_SHARD_RULE.md` should it ever bite again.
 *
 *   The working form: schema-qualified in FROM, bare table name in MATCH:
 *
 *   ```sql
 *   SELECT … FROM pc.place_search WHERE place_search MATCH ?
 * ```
 *
 *   Identical table names across attached shards (which is what we have — every shard ships its own
 *   `place_search` + `place_bbox`) are fine because the bare-name MATCH resolves against FROM
 *   scope.
 */

import { basename } from "node:path"

/**
 * Derive a SQL-safe schema name from a WOF distribution filename. Used by `ATTACH DATABASE … AS <name>` so each shard
 * gets a stable, predictable handle.
 *
 * Convention strips the `whosonfirst-data-` prefix and the `-latest.db` (or just `.db`) suffix, then replaces `-` with
 * `_` for SQL identifier safety.
 *
 * Examples:
 *
 * - `whosonfirst-data-admin-us-latest.db` → `admin_us`
 * - `whosonfirst-data-postalcode-us-latest.db` → `postalcode_us`
 * - `whosonfirst-data-admin-latest.db` → `admin`
 * - `my-custom.db` → `my_custom`
 *
 * Callers can override the derived name explicitly via `ShardConfig.schemaName` when the filename doesn't follow WOF
 * convention.
 */
export function deriveSchemaName(path: string): string {
	const stem = basename(path)
		.replace(/^whosonfirst-data-/u, "")
		.replace(/-latest\.db$/u, "")
		.replace(/\.db$/u, "")
		.replace(/[^a-zA-Z0-9_]/g, "_")

	if (!stem) {
		throw new Error(`deriveSchemaName: could not derive a SQL schema name from path ${JSON.stringify(path)}`)
	}

	return stem
}

/**
 * Per-shard configuration. The simple form is just a path string — the schema name is derived from it. The object form
 * lets callers override the derived schema name (useful when a filename doesn't follow WOF convention) or attach an
 * extra hint about which placetypes route here.
 */
export interface ShardConfig {
	path: string
	/**
	 * Override the auto-derived schema name. Useful when the filename doesn't match WOF convention or when you want a
	 * memorable handle. Must be a valid SQLite identifier — `[a-zA-Z_][a-zA-Z0-9_]*`.
	 */
	schemaName?: string
	/**
	 * Optional explicit list of placetypes this shard serves. When set, queries against any listed placetype are routed
	 * to this shard. When omitted, routing falls back to a name-match heuristic: a shard whose `schemaName` contains the
	 * placetype as a substring (e.g. `postalcode_us` for `postalcode` queries) is preferred for that placetype.
	 */
	placetypes?: readonly string[]
}

/**
 * Resolved post-derivation: paired path + chosen schema name + (possibly empty) placetypes hint. Used internally by
 * `WOFSqlitePlaceLookup` so the routing logic operates on uniform structures.
 */
export interface ResolvedShard {
	path: string
	schemaName: string
	placetypes: readonly string[]
}

/** SQLite identifier regex — `[A-Za-z_][A-Za-z0-9_]*`. */
const SQLITE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Normalize the user-provided `databasePath` opt (which may be a single string, an array of strings, or an array of
 * `ShardConfig` objects) into a uniform `ResolvedShard[]`.
 *
 * The first shard becomes `main` regardless of its derived schema name — that's the SQLite convention. Subsequent
 * shards keep their derived (or override) schema name.
 */
export function resolveShards(input: string | ReadonlyArray<string | ShardConfig>): ResolvedShard[] {
	const list = typeof input === "string" ? [input] : input

	if (list.length === 0) throw new Error("resolveShards: at least one shard is required")

	const seen = new Set<string>()
	const out: ResolvedShard[] = []

	for (let i = 0; i < list.length; i++) {
		const entry = list[i]!
		const cfg: ShardConfig = typeof entry === "string" ? { path: entry } : entry
		const derived = cfg.schemaName ?? deriveSchemaName(cfg.path)

		if (!SQLITE_IDENT_RE.test(derived)) {
			throw new Error(
				`resolveShards: schema name ${JSON.stringify(derived)} is not a valid SQLite identifier ` +
					`(derived from path ${JSON.stringify(cfg.path)}). Pass an explicit ` +
					`{ path, schemaName } to override.`
			)
		}
		// The first shard is always main per SQLite semantics — its derived name is informational
		// only. Subsequent shards must have unique non-main names.
		const schemaName = i === 0 ? "main" : derived

		if (i > 0 && (schemaName === "main" || seen.has(schemaName))) {
			throw new Error(
				`resolveShards: schema name ${JSON.stringify(schemaName)} collides ` +
					`(either with "main" or another shard). Pass an explicit { path, schemaName }.`
			)
		}
		seen.add(schemaName)
		out.push({
			path: cfg.path,
			schemaName,
			placetypes: cfg.placetypes ?? [],
		})
	}

	return out
}

/**
 * Pick the shard to route a query to given the requested placetype(s).
 *
 * Routing rules, in order:
 *
 * 1. If any shard has explicit `placetypes` that includes the requested placetype, use it.
 * 2. Otherwise, if a non-main shard's `schemaName` matches the placetype (e.g. `postalcode_us` matches `postalcode`), use
 *    it.
 * 3. Otherwise, fall back to `main`.
 *
 * This deliberately doesn't UNION across shards — BM25 scores aren't comparable across separately- indexed corpora, and
 * the typical mailwoman query has a single placetype anyway. If a caller needs cross-shard results they can issue two
 * `findPlace` calls.
 */
export function pickShardForPlacetype(shards: ResolvedShard[], placetype: string | undefined): ResolvedShard {
	if (!placetype) return shards[0]!

	for (const s of shards) {
		if (s.placetypes.includes(placetype)) return s
	}

	for (const s of shards) {
		if (s.schemaName === "main") continue

		// Substring match: `postalcode_us` matches `postalcode`. Conservative — requires the
		// placetype to appear at a word boundary in the schema name to avoid false hits like
		// `region` matching `arboregion`.
		if (
			s.schemaName === placetype ||
			s.schemaName.startsWith(`${placetype}_`) ||
			s.schemaName.endsWith(`_${placetype}`)
		) {
			return s
		}
	}

	return shards[0]!
}
