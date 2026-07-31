#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-mcp` — boot the MCP server over stdio. Wires the real `MCPToolDeps` (`tools.ts`) from the mailwoman
 *   library: `createRuntimePipeline` for parse/POI-intent, `geocode-core`'s `geocodeAddress` for geocode,
 *   `mailwoman/poi-overpass`'s `emitOverpassQL` for the export tool, `@mailwoman/core/layers` for the layer
 *   manifest tool, and `@mailwoman/bdc`'s `filingLandscape`/`plausibilityCheck` for the two BDC tools.
 *
 *   Deps are LAZY: nothing here loads the neural weights or opens a gazetteer db at startup — an MCP client
 *   connects, lists tools, and may never call one (or may call `mailwoman_overpass_export`/`mailwoman_layer_manifest`,
 *   neither of which needs the classifier at all). The shared classifier+resolver are built once, on the FIRST call
 *   to any tool that needs them, and cached for the process lifetime.
 *
 *   **Graceful layer-absent guards (2b task 7, decision 6).** Both BDC-backed tools treat a missing/unreadable
 *   database file as absence, never a raw `node:sqlite` throw ("unable to open database file"): `bdcFilingLandscape`
 *   requires bdc.db unconditionally, so a missing file becomes one friendly thrown `Error` naming the layer;
 *   `plausibilityCheck`'s `bdcDB`/`poi` deps are each OPTIONAL, so a missing/absent `bdc_database_path`/
 *   `poi_database_path` degrades to the SAME typed-abstain evidence entry (`{type:"abstain",
 *   reason:"requires_bdc_layer"|"requires_build_local_layer"}`) the scorer already produces for an omitted dep — see
 *   `openBDCDatabaseIfPresent`/`openPlausibilityPOIDeps` below.
 *
 *   ```sh
 *   mailwoman-mcp                       # geocode/poi_search degrade gracefully with no poi.db wired
 *   mailwoman-mcp --poi-db poi.db       # mailwoman_poi_search additionally executes against poi.db
 *   ```
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { filingLandscape, plausibilityCheck, type BDCDatabase, type PlausibilityDeps } from "@mailwoman/bdc"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { getPOICategory } from "@mailwoman/poi-taxonomy"
import { createWOFResolver, type Resolver } from "@mailwoman/resolver"
import { createRuntimePipeline, type PipelineResult } from "mailwoman"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { emitOverpassQL } from "mailwoman/poi-overpass"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

import { createMCPServer } from "./server.ts"
import type { MCPToolDeps } from "./tools.ts"

const { values } = parseArgs({
	options: {
		"poi-db": { type: "string" },
	},
	allowPositionals: true,
})

/**
 * `--poi-db` wires `mailwoman_poi_search` (and, via the same pipeline, `mailwoman_parse`'s `poi: true` path) to a real
 * `poi.db`. Absent → intent-only (parses the query, extracts the subject/anchor, never executes a lookup).
 */
const poiDatabasePath = values["poi-db"]

/**
 * The shared classifier + resolver, built exactly once on the first call that needs them (see the module header).
 * `NeuralAddressClassifier.loadFromWeights` auto-resolves the bundled `en-US` weights; the resolver backend prefers a
 * configured candidate gazetteer (`$MAILWOMAN_CANDIDATE_DB`) and otherwise falls back to the admin-only WOF shards
 * already on the data root — same selection `nominatim`/`photon`'s CLIs make.
 */
let corePromise: Promise<{ classifier: NeuralAddressClassifier; resolver: Resolver; shards: ShardProvider }> | undefined

function loadCore(): Promise<{ classifier: NeuralAddressClassifier; resolver: Resolver; shards: ShardProvider }> {
	corePromise ??= (async () => {
		const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		const wofPaths = wofShardPaths().filter(existsSync)
		const candidateDb = resolveCandidateDBPath()
		const backend = createResolverBackend(resolverMod, { wofPaths, candidateDb })
		const resolver = createWOFResolver(backend)
		const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

		return { classifier, resolver, shards }
	})()

	return corePromise
}

type Pipeline = (raw: string) => Promise<PipelineResult>

let plainPipeline: Pipeline | undefined
/**
 * Keyed by the poi.db path used to build it (`""` = intent-only, no db) — `mailwoman_poi_search` can be called with a
 * `poiDatabasePath` that differs from the server's `--poi-db`, in which case a fresh one-off pipeline is built and
 * cached under that path instead of reusing the default.
 */
const poiPipelines = new Map<string, Pipeline>()

async function getPlainPipeline(): Promise<Pipeline> {
	if (!plainPipeline) {
		const { classifier, resolver } = await loadCore()

		plainPipeline = createRuntimePipeline({ classifier, resolver })
	}

	return plainPipeline
}

async function getPoiPipeline(dbPath: string | undefined): Promise<Pipeline> {
	const key = dbPath ?? ""
	const cached = poiPipelines.get(key)

	if (cached) return cached
	const { classifier, resolver } = await loadCore()

	const pipeline = createRuntimePipeline({
		classifier,
		resolver,
		poiQueryKind: dbPath ? { poiDatabasePath: dbPath } : true,
	})

	poiPipelines.set(key, pipeline)

	return pipeline
}

/**
 * Decision 6 (2b task 7, both halves): open a bdc.db, or return `undefined` when `databasePath` is unset or the file is
 * missing — NEVER a raw sqlite throw. `mailwoman_plausibility_check`'s `bdcDB` dep is OPTIONAL (`PlausibilityDeps`),
 * and `plausibilityCheck` itself already abstains gracefully (a typed `{type:"abstain", reason:"requires_bdc_layer"}`
 * evidence entry) whenever it's `undefined` — so treating "path given but file missing" the same as "path never given
 * at all" is exactly the graceful degradation decision 6 asks for.
 */
function openBDCDatabaseIfPresent(databasePath: string | undefined): DatabaseClient<BDCDatabase> | undefined {
	if (!databasePath || !existsSync(databasePath)) return undefined

	return new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(databasePath, { readOnly: true }) })
}

/**
 * Same graceful discipline as {@link openBDCDatabaseIfPresent}, for the poi.db side of `plausibilityCheck`'s deps —
 * `undefined` here becomes the `{type:"abstain", reason:"requires_build_local_layer"}` entry `plausibilityCheck`
 * already produces when a claimed technology's physical-plant categories can't be searched. `POILookup` is dynamically
 * imported (matching this file's existing `resolver-wof-sqlite` laziness — see the module header) since it's only ever
 * needed when a caller actually wires a poi.db. `lookup` and `contractDB` share ONE `DatabaseSync` handle (the
 * AGENTS.md "one connection, shared" convention) — a real poi.db's rows and its `layer_manifest`/`layer_coverage`
 * tables live in the same file, so disposing `contractDB` (which closes the shared handle) is enough; `POILookup` never
 * owns it (constructed with `{database}`, not `{databasePath}` — see `poi-lookup.ts`), so it never double-closes.
 */
async function openPlausibilityPOIDeps(databasePath: string | undefined): Promise<PlausibilityDeps["poi"]> {
	if (!databasePath || !existsSync(databasePath)) return undefined

	const { POILookup } = await import("@mailwoman/resolver-wof-sqlite/poi-lookup")
	const database = new DatabaseSync(databasePath, { readOnly: true })

	return {
		lookup: new POILookup({ database }),
		contractDB: new DatabaseClient<LayerContractDatabase>({ database }),
	}
}

/**
 * `plausibilityCheck`'s geocode dep — reuses the SAME shared classifier+resolver `deps.geocode` builds from (see the
 * module header's laziness note), wired at this CLI/MCP layer per the 2b task 5 brief ("`deriveGeocodeRegister`/
 * formatted register is the geocode dep's concern, wired at the CLI/MCP layer"). The real return type (`GeocodeResult`)
 * is structurally assignable to `plausibility.ts`'s minimal `GeocodeLike` — no adapter needed.
 */
async function resolveGeocode(address: string) {
	const { classifier, resolver, shards } = await loadCore()

	return geocodeAddress(address, { classifier, resolver, shards: shards.for })
}

const deps: MCPToolDeps = {
	async parse(text, opts) {
		const pipeline = opts?.poi ? await getPoiPipeline(poiDatabasePath) : await getPlainPipeline()

		return pipeline(text)
	},

	async geocode(text) {
		return resolveGeocode(text)
	},

	async poiSearch(q) {
		const pipeline = await getPoiPipeline(q.poiDatabasePath ?? poiDatabasePath)
		const result = await pipeline(q.query)

		return result.poiIntent ?? { type: "abstain", reason: "not_poi_shaped" }
	},

	async overpassExport(query) {
		// Intent-only is enough here — the export just needs the parsed subject/anchor, never executed results
		// ("we print the query; we never run it", poi-overpass.ts). Reuses the server's wired poi pipeline (a
		// real poi.db doesn't change the emitted OverpassQL) instead of forcing a second one-off pipeline.
		const pipeline = await getPoiPipeline(poiDatabasePath)
		const result = await pipeline(query)
		const outcome = result.poiIntent

		if (!outcome || outcome.type !== "intent") {
			const reason = outcome?.type === "abstain" ? `: ${outcome.reason}` : ""

			throw new Error(
				`mailwoman_overpass_export: query is not POI-shaped (${outcome?.type ?? "no poi intent"}${reason})`
			)
		}

		const { subject } = outcome.intent
		const osmTag = subject.kind === "category" ? getPOICategory(subject.categoryID)?.osmTag : undefined

		return emitOverpassQL(outcome.intent, osmTag ? { osmTag } : {})
	},

	async layerManifest(databasePath) {
		using db = new DatabaseClient<LayerContractDatabase>({
			database: new DatabaseSync(databasePath, { readOnly: true }),
		})

		const manifest = await readLayerManifest(db)

		const coverage = await db
			.selectFrom("layer_coverage")
			.select((eb) => [
				eb.fn.count<number>("h3_cell").as("surveyedCellCount"),
				eb.fn.avg<number>("completeness").as("averageCompleteness"),
				eb.fn.sum<number>("observed_rows").as("totalObservedRows"),
			])
			.executeTakeFirst()

		return { manifest, coverage }
	},

	async bdcFilingLandscape(q) {
		// Decision 6 (2b task 7): `mailwoman_bdc_filing_landscape` requires bdc.db unconditionally (no optional-dep
		// abstain shape exists for this tool), so a missing file becomes a friendly thrown Error naming the layer —
		// never the raw `node:sqlite` "unable to open database file" message.
		if (!existsSync(q.databasePath)) {
			throw new Error(`mailwoman_bdc_filing_landscape: bdc.db not found at "${q.databasePath}"`)
		}

		using db = new DatabaseClient<BDCDatabase>({ database: new DatabaseSync(q.databasePath, { readOnly: true }) })

		return filingLandscape(db, { geoids: q.geoids, h3Cells: q.h3Cells })
	},

	async plausibilityCheck(q) {
		const bdcDB = openBDCDatabaseIfPresent(q.bdcDatabasePath)
		const poi = await openPlausibilityPOIDeps(q.poiDatabasePath)

		try {
			return await plausibilityCheck(
				{
					address: q.address,
					point: q.point,
					geoid: q.geoid,
					technologyCode: q.technologyCode,
					claimedDownloadMbps: q.claimedDownloadMbps,
				},
				{ bdcDB, poi, geocode: resolveGeocode }
			)
		} finally {
			bdcDB?.destroy()
			poi?.contractDB.destroy()
		}
	},
}

const server = createMCPServer(deps)
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

await server.connect(new StdioServerTransport())
