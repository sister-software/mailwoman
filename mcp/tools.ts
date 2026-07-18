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
 *   Five tools, one per capability the exotic-POI arc's other packages expose to a human/CLI caller:
 *
 *   - `mailwoman_parse` — the runtime pipeline's parse (optionally POI-aware).
 *   - `mailwoman_geocode` — the street-level geocode cascade (`mailwoman/geocode-core`).
 *   - `mailwoman_poi_search` — POI-intent extraction + (when a poi.db is wired) execution.
 *   - `mailwoman_overpass_export` — OverpassQL EXPORT emitter (`mailwoman/poi-overpass`) — "we print the query;
 *     we never run it".
 *   - `mailwoman_layer_manifest` — read a spatial-layer database's provenance manifest + coverage summary
 *     (`@mailwoman/core/layers`).
 */

import { z } from "zod"

/** The library surface every tool handler dispatches to. `cli.ts` builds the real implementation. */
export interface MCPToolDeps {
	parse: (text: string, opts?: { poi?: boolean }) => Promise<unknown>
	geocode: (text: string) => Promise<unknown>
	poiSearch: (q: { query: string; poiDatabasePath?: string }) => Promise<unknown>
	overpassExport: (query: string) => Promise<string>
	layerManifest: (databasePath: string) => Promise<unknown>
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

/** Build the tool table for a concrete `MCPToolDeps` implementation. Pure — no transport, no I/O of its own. */
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
	]
}
