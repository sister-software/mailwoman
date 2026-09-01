import { basename } from "path-ts"

/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Multi-extract support for `WOFSQLitePlaceLookup` — opens multiple WOF SQLite distributions on one
 *   connection via `ATTACH DATABASE`, and routes queries to the right extract based on placetype.
 *
 *   ## The FTS5 syntax rule that drove this design
 *
 *   The naive `SELECT … FROM pc.place_search WHERE pc.place_search MATCH ?` fails — SQLite parses the
 *   schema-qualified table on the left of MATCH as "column place_search of table pc". Discovered in
 *   the spike at PR review time; documented as `_EXTRACT_RULE.md` should it ever bite again.
 *
 *   The working form: schema-qualified in FROM, bare table name in MATCH:
 *
 *   ```sql
 *   SELECT … FROM pc.place_search WHERE place_search MATCH ?
 * ```
 *
 *   Identical table names across attached extracts (which is what we have — every extract ships its own
 *   `place_search` + `place_bbox`) are fine because the bare-name MATCH resolves against FROM
 *   scope.
 */

/**
 * Derive a SQL-safe schema name from a WOF distribution filename. Used by `ATTACH DATABASE … AS <name>` so each extract
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
 * Callers can override the derived name explicitly via `ExtractConfig.schemaName` when the filename doesn't follow WOF
 * convention.
 */
export function deriveSchemaName(path: string): string {
	const stem = basename(path)
		.replace(/^whosonfirst-data-/u, "")
		.replace(/-latest\.db$/u, "")
		.replace(/\.db$/u, "")
		.replaceAll(/[^a-zA-Z0-9_]/g, "_")

	if (!stem) {
		throw new Error(`deriveSchemaName: could not derive a SQL schema name from path ${JSON.stringify(path)}`)
	}

	return stem
}

/**
 * Per-extract configuration. The simple form is just a path string — the schema name is derived from it. The object
 * form lets callers override the derived schema name (useful when a filename doesn't follow WOF convention) or attach
 * an extra hint about which placetypes route here.
 */
export interface ExtractConfig {
	path: string
	/**
	 * Override the auto-derived schema name. Useful when the filename doesn't match WOF convention or when you want a
	 * memorable handle. Must be a valid SQLite identifier — `[a-zA-Z_][a-zA-Z0-9_]*`.
	 */
	schemaName?: string
	/**
	 * Optional explicit list of placetypes this extract serves. When set, queries against any listed placetype are routed
	 * to this extract. When omitted, routing falls back to a name-match heuristic: a extract whose `schemaName` contains
	 * the placetype as a substring (e.g. `postalcode_us` for `postalcode` queries) is preferred for that placetype.
	 */
	placetypes?: readonly string[]
}

/**
 * Resolved post-derivation: paired path + chosen schema name + (possibly empty) placetypes hint. Used internally by
 * `WOFSQLitePlaceLookup` so the routing logic operates on uniform structures.
 */
export interface ResolvedExtract {
	path: string
	schemaName: string
	placetypes: readonly string[]
}

/**
 * SQLite identifier regex — `[A-Za-z_][A-Za-z0-9_]*`.
 */
const SQLITE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Normalize the user-provided `databasePath` opt (which may be a single string, an array of strings, or an array of
 * `ExtractConfig` objects) into a uniform `ResolvedExtract[]`.
 *
 * The first extract becomes `main` regardless of its derived schema name — that's the SQLite convention. Subsequent
 * extracts keep their derived (or override) schema name.
 */
export function resolveExtracts(input: string | ReadonlyArray<string | ExtractConfig>): ResolvedExtract[] {
	const list = typeof input === "string" ? [input] : input

	if (!list.length) throw new Error("resolveExtracts: at least one extract is required")

	const seen = new Set<string>()
	const out: ResolvedExtract[] = []

	for (let i = 0; i < list.length; i++) {
		const entry = list[i]!
		const cfg: ExtractConfig = typeof entry === "string" ? { path: entry } : entry
		const derived = cfg.schemaName ?? deriveSchemaName(cfg.path)

		if (!SQLITE_IDENT_RE.test(derived)) {
			throw new Error(
				`resolveExtracts: schema name ${JSON.stringify(derived)} is not a valid SQLite identifier ` +
					`(derived from path ${JSON.stringify(cfg.path)}). Pass an explicit ` +
					`{ path, schemaName } to override.`
			)
		}

		// The first extract is always main per SQLite semantics — its derived name is informational
		// only. Subsequent extracts must have unique non-main names.
		const schemaName = i === 0 ? "main" : derived

		if (i > 0 && (schemaName === "main" || seen.has(schemaName))) {
			throw new Error(
				`resolveExtracts: schema name ${JSON.stringify(schemaName)} collides ` +
					`(either with "main" or another extract). Pass an explicit { path, schemaName }.`
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
 * Pick the extract to route a query to given the requested placetype(s).
 *
 * Routing rules, in order:
 *
 * 1. If any extract has explicit `placetypes` that includes the requested placetype, use it.
 * 2. Otherwise, if a non-main extract's `schemaName` matches the placetype (e.g. `postalcode_us` matches `postalcode`),
 *    use it.
 * 3. Otherwise, fall back to `main`.
 *
 * This deliberately doesn't UNION across extracts — BM25 scores aren't comparable across separately- indexed corpora,
 * and the typical mailwoman query has a single placetype anyway. If a caller needs cross-extract results they can issue
 * two `findPlace` calls.
 */
/**
 * All placetype-matching extracts, in routing order (the country-aware pick chooses among these). Used by the bias
 * path: a country-less postcode query with proximity hints fans out across every matching extract and merges, because
 * single-extract routing would hide the cross-country ambiguity the hints exist to resolve ("48026" lives in
 * postalcode-us AND postalcode-intl).
 */
export function pickExtractsForPlacetype(
	extracts: ResolvedExtract[],
	placetype: string | undefined
): ResolvedExtract[] {
	if (!placetype) return [extracts[0]!]
	const matches: ResolvedExtract[] = []

	for (const s of extracts) {
		if (s.placetypes.includes(placetype)) {
			matches.push(s)
		}
	}

	for (const s of extracts) {
		if (s.schemaName === "main" || matches.includes(s)) continue

		if (
			s.schemaName === placetype ||
			s.schemaName.startsWith(`${placetype}_`) ||
			s.schemaName.endsWith(`_${placetype}`)
		) {
			matches.push(s)
		}
	}

	return matches.length ? matches : [extracts[0]!]
}

export function pickExtractForPlacetype(
	extracts: ResolvedExtract[],
	placetype: string | undefined,
	opts?: {
		/**
		 * #920: the query's country constraint, when the caller has one. With MULTIPLE extracts matching a placetype
		 * (postalcode-us + postalcode-geonames-tail), first-match routing sent every postcode query to the first extract
		 * and starved the rest — a FI postcode could never reach the tail extract. When `country` is given and a matching
		 * extract's probed country set contains it, that extract wins; extracts without the country are skipped; the
		 * placetype-match order remains the tiebreak when no extract claims the country (or none was probed).
		 */
		country?: string
		/**
		 * Per-schema probed country sets (see `WOFSQLitePlaceLookup`'s construction probe).
		 */
		countriesBySchema?: ReadonlyMap<string, ReadonlySet<string>>
	}
): ResolvedExtract {
	if (!placetype) return extracts[0]!

	const matches: ResolvedExtract[] = []

	for (const s of extracts) {
		if (s.placetypes.includes(placetype)) {
			matches.push(s)
		}
	}

	for (const s of extracts) {
		if (s.schemaName === "main" || matches.includes(s)) continue

		// Substring match: `postalcode_us` matches `postalcode`. Conservative — requires the
		// placetype to appear at a word boundary in the schema name to avoid false hits like
		// `region` matching `arboregion`.
		if (
			s.schemaName === placetype ||
			s.schemaName.startsWith(`${placetype}_`) ||
			s.schemaName.endsWith(`_${placetype}`)
		) {
			matches.push(s)
		}
	}

	if (!matches.length) return extracts[0]!

	if (opts?.country && opts.countriesBySchema) {
		for (const s of matches) {
			if (opts.countriesBySchema.get(s.schemaName)?.has(opts.country)) return s
		}
	}

	return matches[0]!
}
