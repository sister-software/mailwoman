/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build an FST (finite-state transducer) from a WOF SQLite database. The FST maps normalized token
 *   sequences to PlaceEntry arrays, pre-computing the valid interpretations for every prefix of
 *   every place name in the gazetteer.
 *
 *   Build pipeline: open WOF DB → query spr + names → normalize names → insert into trie → attach
 *   PlaceEntry at terminals → return FSTMatcher.
 */

import { allRows, getRow } from "@mailwoman/core/utils"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { resolvePath } from "path-ts"

import { readWOFSourceIdentity } from "#fst/freshness"
import type { FSTNode } from "#fst/matcher"
import { FSTMatcher, normalizeTokens } from "#fst/matcher"
import type { BuildFSTOpts, BuildFSTResult, FSTProvenance, PlaceEntry, PlacetypeID } from "#fst/types"
import { loadImportanceSplit } from "#place-importance-schema"
import type { WOFDatabase } from "#schema"

const DEFAULT_PLACETYPES: PlacetypeID[] = [
	"country",
	"region",
	"county",
	"locality",
	"localadmin",
	"borough",
	"neighbourhood",
]

const DEFAULT_COUNTRIES = ["US"]
const DEFAULT_LANGUAGES = ["eng", ""]
/**
 * Ids per `IN (…)` batch. SQLITE_MAX_VARIABLE_NUMBER defaults to 32,766; 500 matches the name-load batch a few phases
 * down, so both read paths bind the same shape.
 */
const ANCESTOR_CHUNK = 500

interface SprRow {
	id: number
	name: string
	placetype: string
	parent_id: number
	latitude: number
	longitude: number
}

interface NameRow {
	id: number
	name: string
	language: string
	privateuse: string
}

export async function buildFSTFromWOF(opts: BuildFSTOpts): Promise<{
	matcher: FSTMatcher
	provenance: FSTProvenance
	result: BuildFSTResult
}> {
	const countries = opts.countries ?? DEFAULT_COUNTRIES
	const placetypes = opts.placetypes ?? DEFAULT_PLACETYPES
	const languages = opts.languages ?? DEFAULT_LANGUAGES
	const progress = opts.onProgress ?? (() => {})
	const dbPath = resolvePath(opts.dbPath)

	progress("open", dbPath)
	using db = new DatabaseClient<WOFDatabase>(dbPath, { open: true })

	// Phase 1: Load all matching SPR rows.
	progress("spr", `Loading places for countries=[${countries}], placetypes=[${placetypes}]`)
	const placeholders = (arr: string[]) => arr.map(() => "?").join(",")

	const sprStmt = db.prepare(
		`SELECT id, name, placetype, parent_id, latitude, longitude
		 FROM spr
		 WHERE is_current = 1
		   AND country IN (${placeholders(countries)})
		   AND placetype IN (${placeholders(placetypes)})`
	)

	const sprRows = allRows<SprRow>(sprStmt, ...countries, ...placetypes)
	progress("spr", `Loaded ${sprRows.length} places`)

	// Phase 2: Build a lookup for parent chain resolution.
	const sprByID = new Map<number, SprRow>()

	for (const row of sprRows) {
		sprByID.set(row.id, row)
	}

	// Also load parent rows that might be outside our placetype filter (e.g., country for region).
	const parentStmt = db.prepare("SELECT id, name, placetype, parent_id, latitude, longitude FROM spr WHERE id = ?")

	// Fallback for a sentinel parent_id (-1, -4, …): the ancestors table. Read in chunked `IN (…)`
	// batches ONCE — the point-query version fired per orphan row, and on a global build the orphans
	// run to six figures. Ordering is county → region → country, preserved by the same CASE the
	// per-row query used, with `id` leading so one pass groups the rows.
	const ancestorsByID = new Map<number, number[]>()

	try {
		const orphanIDs = sprRows.filter((row) => row.parent_id <= 0).map((row) => row.id)

		for (let i = 0; i < orphanIDs.length; i += ANCESTOR_CHUNK) {
			const chunk = orphanIDs.slice(i, i + ANCESTOR_CHUNK)

			const rows = allRows<{ id: number; ancestor_id: number }>(
				db.prepare(
					`SELECT DISTINCT id, ancestor_id FROM ancestors
					 WHERE id IN (${chunk.map(() => "?").join(",")}) AND ancestor_placetype IN ('country', 'region', 'county')
					 ORDER BY id, CASE ancestor_placetype
					   WHEN 'county' THEN 1
					   WHEN 'region' THEN 2
					   WHEN 'country' THEN 3
					 END`
				),
				...chunk
			)

			for (const row of rows) {
				let chain = ancestorsByID.get(row.id)

				if (!chain) {
					ancestorsByID.set(row.id, (chain = []))
				}

				chain.push(row.ancestor_id)
			}
		}
	} catch {
		progress("ancestors", "No ancestors table — sentinel parent_ids will produce empty chains")
	}

	function resolveParentChain(id: number): number[] {
		const row = sprByID.get(id)

		if (!row) return []

		// If parent_id is a sentinel (≤ 0), use ancestors table.
		if (row.parent_id <= 0) {
			return (ancestorsByID.get(id) ?? []).filter((ancestorID) => ancestorID !== id)
		}

		// Normal case: walk parent_id chain.
		const chain: number[] = []
		let current = row.parent_id
		const seen = new Set<number>([id])

		while (current > 0 && !seen.has(current)) {
			seen.add(current)
			chain.push(current)
			let parentRow = sprByID.get(current)

			if (!parentRow) {
				const fetched = getRow<SprRow>(parentStmt, current)

				if (!fetched) break
				parentRow = fetched
				sprByID.set(current, parentRow)
			}

			if (parentRow.parent_id > 0 && parentRow.parent_id !== current) {
				current = parentRow.parent_id
			} else {
				break
			}
		}

		return chain
	}

	// Phase 3: Load BOTH scores (ROAD_TO_V9 §2 R1, the two-score split).
	//
	// Referential is ALWAYS population-anchored and never read out of a legacy `place_importance`
	// column, because a legacy row that got a Wikipedia score overwrote whatever population would have
	// said and the two are indistinguishable afterwards. Encyclopedic rides along for consumers and is
	// never handed to the decoder. `loadImportanceSplit` handles all four schema generations; the
	// source it reports is stamped into provenance so an artifact says which one it read.
	progress("importance", "Loading referential + encyclopedic scores")
	const split = loadImportanceSplit(db)

	progress(
		"importance",
		`${split.referential.size} referential, ${split.encyclopedic.size} encyclopedic (source: ${split.source}` +
			(split.legacyFallbackRows ? `, ${split.legacyFallbackRows} legacy rows attributed to the population pass` : "") +
			")"
	)

	// Phase 4: Load names for matching places.
	progress("names", "Loading name variants")
	const placeIDs = sprRows.map((r) => r.id)
	const namesByPlace = new Map<number, string[]>()

	const allLanguages = languages.includes("*")

	for (let i = 0; i < placeIDs.length; i += 500) {
		const chunk = placeIDs.slice(i, i + 500)
		const idPlaceholders = chunk.map(() => "?").join(",")

		const nameStmt = allLanguages
			? db.prepare(`SELECT id, name, language, privateuse FROM names WHERE id IN (${idPlaceholders})`)
			: db.prepare(
					`SELECT id, name, language, privateuse FROM names WHERE id IN (${idPlaceholders}) AND language IN (${languages.map(() => "?").join(",")})`
				)

		const nameRows = allLanguages
			? allRows<NameRow>(nameStmt, ...chunk)
			: allRows<NameRow>(nameStmt, ...chunk, ...languages)

		for (const row of nameRows) {
			const existing = namesByPlace.get(row.id) ?? []

			if (!existing.includes(row.name)) {
				existing.push(row.name)
			}

			namesByPlace.set(row.id, existing)
		}
	}

	progress("names", `Loaded names for ${namesByPlace.size} places`)

	// Phase 5: Build the trie.
	progress("trie", "Building trie")
	const nodes: FSTNode[] = [{ edges: new Map(), places: [] }]

	// Degenerate-surface curation (see BuildFSTOpts.excludeSurfaces). Applied to the WHOLE normalized
	// surface only — a multi-token name containing a function word ("los angeles") is never affected.
	const excludeSurfaces = opts.excludeSurfaces
	const excludeAllTokensOf = opts.excludeAllTokensOf
	let excludedCount = 0

	function isDegenerate(tokens: string[]): boolean {
		if (!tokens.length) return false

		if (excludeSurfaces?.has(tokens.join(" "))) return true

		if (excludeAllTokensOf !== undefined && tokens.every((t) => excludeAllTokensOf.has(t))) return true

		return false
	}

	// Surface-ambiguity classes (survey #4): a per-SURFACE fact, so the entry is cloned per insertion
	// with its accepting surface's count attached (the same place under "nyc" and "new york city"
	// records each surface's own ambiguity). Absent map → entries carry no count (back-compat bytes).
	const surfaceCountryCounts = opts.surfaceCountryCounts

	function insertName(tokens: string[], entry: PlaceEntry): boolean {
		if (!tokens.length) return false

		if (isDegenerate(tokens)) {
			excludedCount++

			return false
		}

		let stateID = 0

		for (const t of tokens) {
			const node = nodes[stateID]!
			let next = node.edges.get(t)

			if (next === undefined) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(t, next)
			}

			stateID = next
		}

		// Deduplicate: don't add the same wofID twice at the same state.
		const existing = nodes[stateID]!.places

		if (!existing.some((p) => p.wofID === entry.wofID && p.placetype === entry.placetype)) {
			if (surfaceCountryCounts !== undefined) {
				const count = surfaceCountryCounts.get(tokens.join(" "))
				existing.push({ ...entry, crossCountryBranches: Math.min(count ?? 1, 255) })
			} else {
				existing.push(entry)
			}
		}

		return true
	}

	let insertCount = 0

	for (const row of sprRows) {
		const parentChain = resolveParentChain(row.id)

		const encyclopedic = split.encyclopedic.get(row.id)

		const entry: PlaceEntry = {
			wofID: row.id,
			placetype: row.placetype as PlacetypeID,
			name: row.name,
			parentChain,
			referential: split.referential.get(row.id) ?? 0,
			// Spread rather than assigned: a place with no Wikipedia article must carry NO field, not a
			// zero. The serializer's per-place presence bit reads `!== undefined`.
			...(encyclopedic === undefined ? {} : { encyclopedic }),
			lat: row.latitude,
			lon: row.longitude,
		}

		// Insert the primary name from spr.
		const primaryTokens = normalizeTokens(row.name)

		if (insertName(primaryTokens, entry)) {
			insertCount++
		}

		// Insert alt names from the names table.
		const altNames = namesByPlace.get(row.id) ?? []

		for (const altName of altNames) {
			if (altName === row.name) continue
			const altTokens = normalizeTokens(altName)

			if (altTokens.length && altTokens.join(" ") !== primaryTokens.join(" ") && insertName(altTokens, entry)) {
				insertCount++
			}
		}
	}

	progress(
		"done",
		`Built trie: ${nodes.length} states, ${insertCount} name insertions` +
			(excludedCount > 0 ? ` (${excludedCount} degenerate surfaces excluded)` : "")
	)

	const edgeCount = nodes.reduce((sum, n) => sum + n.edges.size, 0)
	const matcher = FSTMatcher.fromNodes(nodes)

	// The build stamp (2026-08-05). `sourceDB` alone was never enough to tell a reader whether this
	// artifact matches the database at that path — the admin DB is sealed and REPLACED by a rebuild, so
	// the path is constant across every generation of it. Hashing costs 7.3 s for the 5.27 GB admin DB
	// and is free whenever the `.md5` sidecar is current, which the admin build already writes.
	// `sourceIdentity` lets a caller that already knows the digest (or is building from something that
	// is not a file at all) supply it instead.
	progress("stamp", `Reading source identity for ${dbPath}`)
	const source = opts.sourceIdentity ?? (await readWOFSourceIdentity(dbPath))

	const provenance: FSTProvenance = {
		builtAt: new Date().toISOString(),
		countries,
		stateCount: nodes.length,
		placeCount: sprRows.length,
		edgeCount,
		nameInsertions: insertCount,
		importanceMatches: split.referential.size,
		encyclopedicMatches: split.encyclopedic.size,
		importanceSource: split.source,
		sourceDB: dbPath,
		sourceDBMD5: source.md5,
		sourceDBBytes: source.bytes,
		...(excludeSurfaces !== undefined || excludeAllTokensOf !== undefined
			? { exclusionPolicy: opts.exclusionPolicy ?? "unspecified", excludedInsertions: excludedCount }
			: {}),
	}

	return {
		matcher,
		provenance,
		result: {
			stateCount: nodes.length,
			placeCount: sprRows.length,
			edgeCount,
			tokenCount: insertCount,
		},
	}
}
