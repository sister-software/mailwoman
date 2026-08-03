/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The MCP tool table — pure, transport-free. `server.ts` adapts this to the `@modelcontextprotocol/sdk`'s
 *   registration API; `cli.ts` builds the real `MCPToolDeps` from the mailwoman library. Kept separate so this
 *   file (the actual product surface) is testable without any MCP plumbing — `tools.test.ts` calls
 *   `buildToolTable` directly with stub deps.
 *
 *   One tool per capability the exotic-POI/BDC arcs' other packages expose to a human/CLI caller — see
 *   `buildToolTable`'s return value for the authoritative, current list (this comment intentionally states no count,
 *   so it can't go stale as tools are added):
 *
 *   - `mailwoman_parse` — the runtime pipeline's parse (optionally POI-aware).
 *   - `mailwoman_geocode` — the street-level geocode cascade (`mailwoman/geocode-core`).
 *   - `mailwoman_poi_search` — POI-intent extraction + (when a poi.db is wired) execution.
 *   - `mailwoman_overpass_export` — OverpassQL EXPORT emitter (`mailwoman/poi-overpass`) — "we print the query;
 *     we never run it".
 *   - `mailwoman_layer_manifest` — read a spatial-layer database's provenance manifest + coverage summary
 *     (`@mailwoman/core/layers`).
 *   - `mailwoman_bdc_filing_landscape` — read a bdc.db layer's provider/technology/speed-bucket filing census over a
 *     set of census blocks or H3 cells (`@mailwoman/bdc`'s `filingLandscape`).
 *   - `mailwoman_plausibility_check` — score one claimed broadband-service assertion against BDC filing evidence and
 *     nearby telecom infrastructure (`@mailwoman/bdc`'s `plausibilityCheck`), returning a positive-evidence-only bundle
 *     with an always-present `coverage_confidence`. A missing/absent `bdc_database_path`/`poi_database_path` degrades
 *     to a typed abstain entry in the bundle, never a throw (decision 6).
 *   - `mailwoman_filer_lookup` — read the FCC filer identity crosswalk (`@mailwoman/filer`'s
 *     `filerLookup`) for one identifier (FRN, Form 499 ID, or BDC provider ID): every OTHER identifier it shares an
 *     authoritative edge with, its current attributes, its authoritative entity cluster, and any inferred links —
 *     reported separately, never merged into the cluster. `as_of` is always present (defaults to today).
 *   - `mailwoman_filer_family` — read a corporate family's membership (`@mailwoman/filer/sdk`'s
 *     `familyRollup`) from a filer.db layer database, given a `family_id` or a `node_id`. Distinct from an entity
 *     cluster (same filer, different identifiers) — a corporate family spans several DIFFERENT filers under a
 *     holding/parent/subsidiary/management relationship. The handler passes `familyRollup`'s result through
 *     unchanged: no reshaping, filtering, or summarizing of who-owns-whom data.
 */

import { z } from "zod"

/**
 * The library surface every tool handler dispatches to. `cli.ts` builds the real implementation.
 */
export interface MCPToolDeps {
	parse: (text: string, opts?: { poi?: boolean }) => Promise<unknown>
	geocode: (text: string) => Promise<unknown>
	poiSearch: (q: { query: string; poiDatabasePath?: string }) => Promise<unknown>
	overpassExport: (query: string) => Promise<string>
	layerManifest: (databasePath: string) => Promise<unknown>
	bdcFilingLandscape: (q: { databasePath: string; geoids?: string[]; h3Cells?: number[] }) => Promise<unknown>
	plausibilityCheck: (q: {
		bdcDatabasePath?: string
		poiDatabasePath?: string
		address?: string
		point?: { type: "Point"; coordinates: [number, number] }
		geoid?: string
		technologyCode: number
		claimedDownloadMbps: number
	}) => Promise<unknown>
	filerLookup: (q: {
		databasePath: string
		frn?: string
		form499ID?: string
		bdcProviderID?: number
		asOf?: string
	}) => Promise<unknown>
	filerFamily: (q: { databasePath: string; familyID?: string; nodeID?: string; asOf?: string }) => Promise<unknown>
}

/**
 * One MCP tool. `inputSchema` is a plain Zod object (not `any` — this repo's oxlint config errors on
 * `typescript/no-explicit-any`) — `z.ZodRawShape` is zod's own umbrella type for "any object shape", so this stays
 * generic over the concrete per-tool schemas without reaching for `any`. `handler` re-parses `args` through the same
 * schema (cheap; zod objects are small here) rather than trusting an unchecked cast, so the array of heterogeneous
 * tools stays type-safe internally despite the necessarily-uniform external shape.
 */
export interface MCPToolDef {
	name: string
	description: string
	inputSchema: z.ZodObject<z.ZodRawShape>
	handler: (args: Record<string, unknown>) => Promise<unknown>
}

const ParseInputSchema = z.object({
	text: z.string().min(1).describe("The free-text location string to parse (a postal address or a POI query)."),
	poi: z
		.boolean()
		.optional()
		.describe(
			"Also run POI-intent detection/extraction (category/brand/name subject + spatial anchor). Default false — plain address parse."
		),
})

const GeocodeInputSchema = z.object({
	text: z.string().min(1).describe("The free-text postal address to geocode."),
})

const POISearchInputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe(
			"A free-text POI query with a spatial anchor, e.g. 'coffee shops near 350 5th Ave, New York' or 'starbucks in Chicago'."
		),
	poiDatabasePath: z
		.string()
		.optional()
		.describe("Path to a specific poi.db shard to search. Omit to use the server's configured default (if any)."),
})

const OverpassExportInputSchema = z.object({
	query: z
		.string()
		.min(1)
		.describe("A free-text POI query (same shape as mailwoman_poi_search) to render as an OverpassQL query."),
})

const LayerManifestInputSchema = z.object({
	databasePath: z
		.string()
		.min(1)
		.describe("Path to a mailwoman spatial-layer database (poi.db, an address-points shard, etc.)."),
})

const BDCFilingLandscapeInputSchema = z.object({
	database_path: z
		.string()
		.min(1)
		.describe("Path to a bdc.db layer database (FCC Broadband Data Collection availability)."),
	geoids: z
		.array(z.string())
		.min(1)
		.optional()
		.describe(
			"15-character census block GEOIDs to query. Provide exactly one of `geoids` or `h3_cells` — never both, never neither, never empty."
		),
	h3_cells: z
		.array(z.number())
		.min(1)
		.optional()
		.describe(
			"Resolution-9 short H3 cell integers (the bdc.db availability spine) to query directly. Provide exactly " +
				"one of `geoids` or `h3_cells` — never both, never neither, never empty."
		),
})

const PlausibilityCheckPointInputSchema = z.object({
	type: z.literal("Point").describe('GeoJSON geometry type — always "Point".'),
	coordinates: z
		.tuple([z.number(), z.number()])
		.describe("[longitude, latitude] pair, GeoJSON coordinate order (longitude first)."),
})

const PlausibilityCheckInputSchema = z.object({
	bdc_database_path: z
		.string()
		.optional()
		.describe(
			"Path to a bdc.db layer database (FCC Broadband Data Collection availability). Omit — or point at a file " +
				"that doesn't exist — to abstain on filing evidence rather than error."
		),
	poi_database_path: z
		.string()
		.optional()
		.describe(
			"Path to a poi.db layer database carrying the telecom-infrastructure categories (`telecom_exchange`, " +
				"`tower_comms`, etc.). Omit — or point at a file that doesn't exist — to abstain on physical-plant " +
				"evidence rather than error."
		),
	address: z
		.string()
		.optional()
		.describe(
			"The claimed service location as a free-text postal address, geocoded via the server's runtime pipeline " +
				"when `point` isn't also given. At least one of `address`, `point`, or `geoid` is required."
		),
	point: PlausibilityCheckPointInputSchema.optional().describe(
		"The claimed service location as a GeoJSON Point, bypassing geocoding. At least one of `address`, `point`, " +
			"or `geoid` is required."
	),
	geoid: z
		.string()
		.optional()
		.describe(
			"15-character census block GEOID for the claimed service location — the exact, native filing-evidence " +
				"path (no h3-cell approximation). May be supplied alongside `point`/`address` (geoid drives filing " +
				"evidence; the point drives physical-plant evidence independently). At least one of `address`, " +
				"`point`, or `geoid` is required."
		),
	technology_code: z
		.number()
		.describe(
			"FCC BDC technology code for the claimed service, e.g. 50 = optical carrier fiber (BroadbandTechnologyCode)."
		),
	claimed_download_mbps: z.number().describe("The claimed downstream speed in Mbps."),
})

const FilerLookupInputSchema = z.object({
	database_path: z.string().min(1).describe("Path to a filer.db layer database (FCC filer identity crosswalk)."),
	frn: z
		.string()
		.optional()
		.describe(
			"The zero-padded 10-digit FCC Registration Number to look up, e.g. '0001753557'. Provide exactly one of " +
				"`frn`, `form499_id`, or `bdc_provider_id` — never more than one, never none."
		),
	form499_id: z
		.string()
		.optional()
		.describe(
			"The FCC Form 499 filer ID to look up. Provide exactly one of `frn`, `form499_id`, or `bdc_provider_id` — " +
				"never more than one, never none."
		),
	bdc_provider_id: z
		.number()
		.optional()
		.describe(
			"The FCC BDC provider_id to look up. Provide exactly one of `frn`, `form499_id`, or `bdc_provider_id` — " +
				"never more than one, never none."
		),
	as_of: z
		.string()
		.optional()
		.describe(
			"ISO date (YYYY-MM-DD) to scope the lookup as-of — only relationships valid on or before this date, and not " +
				"yet closed by it, are included. Defaults to today; the result always states the date actually used."
		),
})

const FilerFamilyInputSchema = z.object({
	database_path: z.string().min(1).describe("Path to a filer.db layer database (FCC filer identity crosswalk)."),
	family_id: z
		.string()
		.optional()
		.describe(
			"The canonicalized family_id to roll up, e.g. as returned by mailwoman_filer_lookup's `families` field. " +
				"Provide exactly one of `family_id` or `node_id` — never both, never neither."
		),
	node_id: z
		.string()
		.optional()
		.describe(
			"A filer-graph node_id (e.g. 'frn:0001753557') to resolve EVERY corporate family it currently belongs to " +
				"— a node may legitimately belong to more than one (e.g. a different holding company vs. management " +
				"company). Provide exactly one of `family_id` or `node_id` — never both, never neither."
		),
	as_of: z
		.string()
		.optional()
		.describe(
			"ISO date (YYYY-MM-DD) to scope the rollup as-of — only family memberships valid on or before this date, " +
				"and not yet closed by it, are included. Defaults to today; each returned family states the date " +
				"actually used."
		),
})

/**
 * Build the tool table for a concrete `MCPToolDeps` implementation. Pure — no transport, no I/O of its own.
 */
export function buildToolTable(deps: MCPToolDeps): MCPToolDef[] {
	return [
		{
			name: "mailwoman_parse",
			description:
				"Parse a free-text location string (postal address or POI query) into a structured address tree — house " +
				"number, street, locality, region, postcode, country, and (with `poi: true`) a POI intent. Use this to " +
				"understand a query's structure before geocoding or searching; it does not resolve coordinates.",
			inputSchema: ParseInputSchema,
			handler: async (args) => {
				const { text, poi } = ParseInputSchema.parse(args)

				return deps.parse(text, { poi })
			},
		},
		{
			name: "mailwoman_geocode",
			description:
				"Geocode a free-text postal address to coordinates via the full parse-then-resolve cascade (rooftop > " +
				"interpolated > street > admin resolution tiers). Returns lat/lon, the resolution tier, an uncertainty " +
				"radius in meters, and the resolved admin hierarchy. Use this to convert an address string into a location.",
			inputSchema: GeocodeInputSchema,
			handler: async (args) => {
				const { text } = GeocodeInputSchema.parse(args)

				return deps.geocode(text)
			},
		},
		{
			name: "mailwoman_poi_search",
			description:
				"Search for points of interest — a category ('coffee shop'), a brand ('Starbucks'), or a named place — " +
				"near the spatial anchor extracted from the query text (e.g. 'pharmacies near 10 Downing St, London'). " +
				"Returns the parsed intent and, when a POI database is available, ranked nearby results.",
			inputSchema: POISearchInputSchema,
			handler: async (args) => {
				const { query, poiDatabasePath } = POISearchInputSchema.parse(args)

				return deps.poiSearch({ query, poiDatabasePath })
			},
		},
		{
			name: "mailwoman_overpass_export",
			description:
				"Turn a POI-shaped query into an OverpassQL query string for Overpass Turbo — this NEVER executes the " +
				"query itself, it only prints it. Use this when the operator wants to explore or run the search " +
				"themselves against live OpenStreetMap data.",
			inputSchema: OverpassExportInputSchema,
			handler: async (args) => {
				const { query } = OverpassExportInputSchema.parse(args)

				return deps.overpassExport(query)
			},
		},
		{
			name: "mailwoman_layer_manifest",
			description:
				"Inspect a mailwoman spatial-layer database (poi.db, an address-points shard, etc.): read its provenance " +
				"and licensing manifest (source, vintage, build command, license) plus a coverage summary (how many H3 " +
				"cells were surveyed, average completeness, total observed rows). Use this to check what a layer " +
				"actually covers before relying on it.",
			inputSchema: LayerManifestInputSchema,
			handler: async (args) => {
				const { databasePath } = LayerManifestInputSchema.parse(args)

				return deps.layerManifest(databasePath)
			},
		},
		{
			name: "mailwoman_bdc_filing_landscape",
			description:
				"Read the FCC Broadband Data Collection (BDC) provider/technology/speed-bucket filing census over a set " +
				"of census blocks (`geoids`) or H3 cells (`h3_cells`) from a bdc.db layer database. Returns the source " +
				"vintage, how many queried blocks were surveyed vs. unknown (never surveyed), and the filing summary. " +
				"Provide exactly one of `geoids` or `h3_cells`.",
			inputSchema: BDCFilingLandscapeInputSchema,
			handler: async (args) => {
				const { database_path, geoids, h3_cells } = BDCFilingLandscapeInputSchema.parse(args)

				return deps.bdcFilingLandscape({ databasePath: database_path, geoids, h3Cells: h3_cells })
			},
		},
		{
			name: "mailwoman_plausibility_check",
			description:
				"Score one claimed broadband-service assertion (technology + speed at a location) against the FCC BDC " +
				"filing census and nearby telecom infrastructure, returning an evidence bundle: filings that corroborate " +
				"(or don't), nearby physical plant, and a coverage_confidence reflecting survey completeness. NEVER " +
				"returns a verdict stronger than 'no supporting evidence found' — absence of evidence degrades " +
				"confidence, it never disproves the claim. Provide at least one of `address`, `point`, or `geoid`.",
			inputSchema: PlausibilityCheckInputSchema,
			handler: async (args) => {
				const { bdc_database_path, poi_database_path, address, point, geoid, technology_code, claimed_download_mbps } =
					PlausibilityCheckInputSchema.parse(args)

				return deps.plausibilityCheck({
					bdcDatabasePath: bdc_database_path,
					poiDatabasePath: poi_database_path,
					address,
					point,
					geoid,
					technologyCode: technology_code,
					claimedDownloadMbps: claimed_download_mbps,
				})
			},
		},
		{
			name: "mailwoman_filer_lookup",
			description:
				"Look up the FCC filer identity crosswalk for one identifier (FRN, Form 499 filer ID, or BDC provider_id) " +
				"from a filer.db layer database: every OTHER identifier it shares an authoritative edge with (never " +
				"collapsed — a provider_id carrying multiple FRNs reports all of them), its current attributes, its " +
				"authoritative entity cluster, and any inferred links reported SEPARATELY with their score — never merged " +
				"into the cluster. Scoped `as_of` a date (defaults to today, always present in the result). Provide " +
				"exactly one of `frn`, `form499_id`, or `bdc_provider_id`.",
			inputSchema: FilerLookupInputSchema,
			handler: async (args) => {
				const { database_path, frn, form499_id, bdc_provider_id, as_of } = FilerLookupInputSchema.parse(args)

				return deps.filerLookup({
					databasePath: database_path,
					frn,
					form499ID: form499_id,
					bdcProviderID: bdc_provider_id,
					asOf: as_of,
				})
			},
		},
		{
			name: "mailwoman_filer_family",
			description:
				"Read a corporate family's full membership from a filer.db layer database — a holding/parent/subsidiary/" +
				"management tree spanning several DIFFERENT filers, distinct from an entity cluster (same filer, " +
				"different identifiers). Given `family_id`, returns that one family's members; given `node_id`, " +
				"resolves EVERY family that node currently belongs to (a node MAY belong to more than one). Each " +
				"returned family reports its members with relationship, source, and assertion (`authoritative` — the " +
				"source document states the membership — vs `inferred` — a name match concluded it, with its " +
				"match_score), a deduped distinct_member_count, and its known display names. Provide exactly one of " +
				"`family_id` or `node_id`.",
			inputSchema: FilerFamilyInputSchema,
			handler: async (args) => {
				const { database_path, family_id, node_id, as_of } = FilerFamilyInputSchema.parse(args)

				return deps.filerFamily({
					databasePath: database_path,
					familyID: family_id,
					nodeID: node_id,
					asOf: as_of,
				})
			},
		},
	]
}
