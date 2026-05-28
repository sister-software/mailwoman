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
 *   PlaceEntry at terminals → return FstMatcher.
 */

import { DatabaseSync } from "node:sqlite"
import type { FstNode } from "./fst-matcher.js"
import { FstMatcher, normalizeTokens } from "./fst-matcher.js"
import type { BuildFstOpts, BuildFstResult, FstProvenance, PlaceEntry, PlacetypeId } from "./fst-types.js"

const DEFAULT_PLACETYPES: PlacetypeId[] = [
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

interface PopulationRow {
	id: number
	population: number
}

export function buildFstFromWof(opts: BuildFstOpts): {
	matcher: FstMatcher
	provenance: FstProvenance
	result: BuildFstResult
} {
	const countries = opts.countries ?? DEFAULT_COUNTRIES
	const placetypes = opts.placetypes ?? DEFAULT_PLACETYPES
	const languages = opts.languages ?? DEFAULT_LANGUAGES
	const progress = opts.onProgress ?? (() => {})

	progress("open", opts.dbPath)
	const db = new DatabaseSync(opts.dbPath, { open: true })

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
	const sprRows = sprStmt.all(...countries, ...placetypes) as unknown as SprRow[]
	progress("spr", `Loaded ${sprRows.length} places`)

	// Phase 2: Build a lookup for parent chain resolution.
	const sprByID = new Map<number, SprRow>()
	for (const row of sprRows) sprByID.set(row.id, row)

	// Also load parent rows that might be outside our placetype filter (e.g., country for region).
	const parentStmt = db.prepare("SELECT id, name, placetype, parent_id, latitude, longitude FROM spr WHERE id = ?")

	// Fallback: use ancestors table when parent_id is a sentinel (-1, -4, etc.).
	let ancestorStmt: ReturnType<typeof db.prepare> | null = null
	try {
		ancestorStmt = db.prepare(
			`SELECT DISTINCT ancestor_id FROM ancestors
			 WHERE id = ? AND ancestor_placetype IN ('country', 'region', 'county')
			 ORDER BY CASE ancestor_placetype
			   WHEN 'county' THEN 1
			   WHEN 'region' THEN 2
			   WHEN 'country' THEN 3
			 END`
		)
	} catch {
		progress("ancestors", "No ancestors table — sentinel parent_ids will produce empty chains")
	}

	function resolveParentChain(id: number): number[] {
		const row = sprByID.get(id)
		if (!row) return []

		// If parent_id is a sentinel (≤ 0), use ancestors table.
		if (row.parent_id <= 0 && ancestorStmt) {
			const ancestors = ancestorStmt.all(id) as unknown as Array<{ ancestor_id: number }>
			return ancestors.map((a) => a.ancestor_id).filter((aid) => aid !== id)
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
				const fetched = parentStmt.get(current) as unknown as SprRow | undefined
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

	// Phase 3: Load importance data (Wikipedia-based, falls back to population-scaled).
	// See docs/articles/concepts/importance-vs-population.md for the two-signal contract.
	progress("importance", "Loading importance data")
	const importanceMap = new Map<number, number>()
	try {
		const impStmt = db.prepare("SELECT id, importance FROM place_importance")
		const impRows = impStmt.all() as unknown as Array<{ id: number; importance: number }>
		for (const row of impRows) importanceMap.set(row.id, row.importance)
		progress("importance", `Loaded ${importanceMap.size} importance scores`)
	} catch {
		progress("importance", "No place_importance table — falling back to population")
		try {
			const popStmt = db.prepare("SELECT id, population FROM place_population")
			const popRows = popStmt.all() as unknown as PopulationRow[]
			for (const row of popRows) {
				const normalized = row.population > 0 ? Math.min(1.0, Math.log2(1 + row.population / 1000) / 14) : 0
				importanceMap.set(row.id, normalized)
			}
		} catch {
			progress("importance", "No place_population either — using 0 for all")
		}
	}

	// Phase 4: Load names for matching places.
	progress("names", "Loading name variants")
	const placeIds = sprRows.map((r) => r.id)
	const namesByPlace = new Map<number, string[]>()

	const allLanguages = languages.includes("*")
	for (let i = 0; i < placeIds.length; i += 500) {
		const chunk = placeIds.slice(i, i + 500)
		const idPlaceholders = chunk.map(() => "?").join(",")
		const nameStmt = allLanguages
			? db.prepare(`SELECT id, name, language, privateuse FROM names WHERE id IN (${idPlaceholders})`)
			: db.prepare(
					`SELECT id, name, language, privateuse FROM names WHERE id IN (${idPlaceholders}) AND language IN (${languages.map(() => "?").join(",")})`
				)
		const nameRows = (allLanguages ? nameStmt.all(...chunk) : nameStmt.all(...chunk, ...languages)) as unknown as NameRow[]
		for (const row of nameRows) {
			const existing = namesByPlace.get(row.id) ?? []
			if (!existing.includes(row.name)) existing.push(row.name)
			namesByPlace.set(row.id, existing)
		}
	}
	progress("names", `Loaded names for ${namesByPlace.size} places`)

	// Phase 5: Build the trie.
	progress("trie", "Building trie")
	const nodes: FstNode[] = [{ edges: new Map(), places: [] }]

	function insertName(tokens: string[], entry: PlaceEntry): void {
		if (tokens.length === 0) return
		let stateId = 0
		for (const t of tokens) {
			const node = nodes[stateId]!
			let next = node.edges.get(t)
			if (next === undefined) {
				next = nodes.length
				nodes.push({ edges: new Map(), places: [] })
				node.edges.set(t, next)
			}
			stateId = next
		}
		// Deduplicate: don't add the same wofID twice at the same state.
		const existing = nodes[stateId]!.places
		if (!existing.some((p) => p.wofID === entry.wofID && p.placetype === entry.placetype)) {
			existing.push(entry)
		}
	}

	let insertCount = 0
	for (const row of sprRows) {
		const parentChain = resolveParentChain(row.id)
		const entry: PlaceEntry = {
			wofID: row.id,
			placetype: row.placetype as PlacetypeId,
			name: row.name,
			parentChain,
			importance: importanceMap.get(row.id) ?? 0,
			lat: row.latitude,
			lon: row.longitude,
		}

		// Insert the primary name from spr.
		const primaryTokens = normalizeTokens(row.name)
		insertName(primaryTokens, entry)
		insertCount++

		// Insert alt names from the names table.
		const altNames = namesByPlace.get(row.id) ?? []
		for (const altName of altNames) {
			if (altName === row.name) continue
			const altTokens = normalizeTokens(altName)
			if (altTokens.length > 0 && altTokens.join(" ") !== primaryTokens.join(" ")) {
				insertName(altTokens, entry)
				insertCount++
			}
		}
	}

	db.close()
	progress("done", `Built trie: ${nodes.length} states, ${insertCount} name insertions`)

	const edgeCount = nodes.reduce((sum, n) => sum + n.edges.size, 0)
	const matcher = FstMatcher.fromNodes(nodes)
	const provenance: FstProvenance = {
		builtAt: new Date().toISOString(),
		countries,
		stateCount: nodes.length,
		placeCount: sprRows.length,
		edgeCount,
		nameInsertions: insertCount,
		importanceMatches: importanceMap.size,
		sourceDb: opts.dbPath,
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
