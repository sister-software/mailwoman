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
 *   connects, lists tools, and may never call one (or may call only the layer-database tools, none of which touch the
 *   classifier). The shared classifier+resolver are built once, on the FIRST call to any tool that needs them, and
 *   cached for the process lifetime. `mailwoman_overpass_export` DOES need them despite never executing a query — it
 *   parses the input to find the subject and anchor before it can emit OverpassQL.
 *
 *   **Laziness moves the first failure into a tool call, so `loadCore` owns the friendly-failure messages** that
 *   `photon`/`nominatim`/`mailwoman serve` print at boot. Both are thrown, not printed: `server.ts` catches a handler
 *   throw and returns it as an `isError` tool result, so a thrown message reaches the agent where a `console.error` +
 *   `process.exit(1)` would just kill the transport mid-conversation. See `loadCore` for the two.
 *
 *   **Graceful layer-absent guards (decision 6).** Both BDC-backed tools treat a missing/unreadable
 *   database file as absence, never a raw `node:sqlite` throw ("unable to open database file"): `bdcFilingLandscape`
 *   requires bdc.db unconditionally, so a missing file becomes one friendly thrown `Error` naming the layer;
 *   `plausibilityCheck`'s `bdcDB`/`poi` deps are each OPTIONAL, so a missing/absent `bdc_database_path`/
 *   `poi_database_path` degrades to the SAME typed-abstain evidence entry (`{type:"abstain",
 *   reason:"requires_bdc_layer"|"requires_build_local_layer"}`) the scorer already produces for an omitted dep. The
 *   guards themselves (`assertBDCDatabaseExists`, `openBDCDatabaseIfPresent`, `openPlausibilityPOIDeps`) live in
 *   `./layer-guards.ts`, NOT here — they're pure, transport-independent logic with no need for the stdio connection
 *   this file opens at import time (which is exactly why THIS file can't be unit-tested directly; see
 *   `layer-guards.test.ts` for their branch coverage).
 *
 *   `mailwoman_filer_lookup` follows the SAME "requires the layer unconditionally" discipline as
 *   `mailwoman_bdc_filing_landscape` (`assertFilerDatabaseExists` + `openFilerDatabaseIfPresent`, mirroring
 *   `assertBDCDatabaseExists` + the BDC open) — `filerLookup` itself has no optional-dep abstain shape (gate 4 makes
 *   it throw rather than answer unstamped), so a missing filer.db becomes one friendly thrown Error naming the layer.
 *
 *   `mailwoman_filer_family` follows the IDENTICAL discipline, reusing the same two guards — `familyRollup`
 *   has no optional-dep abstain shape either (it throws on a bad `familyID`/`nodeID` XOR or a pre-`filer_family`
 *   schema), so filer.db is required unconditionally here too. Its result — always `FamilyRollup[]`, never `null` or
 *   a bare object — is passed through untouched: this data is who-owns-whom, and a silent reshape here would be a
 *   fabricated relationship claim.
 *
 *   ```sh
 *   mailwoman-mcp                       # geocode/poi_search degrade gracefully with no poi.db wired
 *   mailwoman-mcp --poi-db poi.db       # mailwoman_poi_search additionally executes against poi.db
 *   ```
 */

import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"

import { filingLandscape, plausibilityCheck, type BDCDatabase } from "@mailwoman/bdc"
import { DatabaseClient } from "@mailwoman/core/kysley/client"
import { readLayerManifest, type LayerContractDatabase } from "@mailwoman/core/layers"
import { familyRollup, filerLookup, toFRN, type FRN } from "@mailwoman/filer/sdk"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { getPOICategory } from "@mailwoman/poi-taxonomy"
import { createWOFResolver, type Resolver } from "@mailwoman/resolver"
import { createRuntimePipeline, type PipelineResult } from "mailwoman"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { emitOverpassQL } from "mailwoman/poi-overpass"
import {
	buildNoGazetteerMessage,
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

import {
	assertBDCDatabaseExists,
	assertFilerDatabaseExists,
	openBDCDatabaseIfPresent,
	openFilerDatabaseIfPresent,
	openPlausibilityPOIDeps,
} from "./layer-guards.ts"
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

/**
 * The four tools that need {@link loadCore} — every path through `getPlainPipeline`/`getPoiPipeline`/`resolveGeocode`.
 * `mailwoman_layer_manifest`, `mailwoman_bdc_filing_landscape`, `mailwoman_filer_lookup` and `mailwoman_filer_family`
 * never call it, so they keep working when this fails; `mailwoman_plausibility_check` only reaches it when it geocodes.
 * Named in both guard messages below because an agent that just got one needs to know what it can still do.
 */
const CORE_BACKED_TOOLS = "mailwoman_parse, mailwoman_geocode, mailwoman_poi_search, mailwoman_overpass_export"

const CORE_FREE_TOOLS =
	"mailwoman_layer_manifest, mailwoman_bdc_filing_landscape, mailwoman_filer_lookup, mailwoman_filer_family"

function loadCore(): Promise<{ classifier: NeuralAddressClassifier; resolver: Resolver; shards: ShardProvider }> {
	corePromise ??= (async () => {
		const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		const wofPaths = wofShardPaths().filter(existsSync)
		const candidateDb = resolveCandidateDBPath()

		// #1009 friendly-failure discipline, the MCP shape of it. `server.ts` turns a thrown Error into an
		// `isError` tool result carrying `error.message`, so the message an agent reads IS whatever is thrown
		// here — which made the raw internal `resolveShards: at least one shard is required` the first thing a
		// stranger saw from `mailwoman_parse` on a fresh install (measured 2026-08-03 against a standalone
		// `npm install @mailwoman/mcp`). Same preflight as `photon`/`nominatim`/`mailwoman serve`, and the same
		// discovery: #1444 moved the `<data-root>/wof/candidate.db` convention fallback INTO
		// `resolveCandidateDBPath`, so this bare call picks a pulled gazetteer up with nothing exported. The
		// `MAILWOMAN_DATA_ROOT` in the client's `env` block is enough on its own.
		if (!candidateDb && !wofPaths.length) {
			throw new Error(
				`${buildNoGazetteerMessage({
					dataRoot: mailwomanDataRoot(),
					docsPath: "/docs/developers/how-to/use-the-mcp-server",
				})}\n\n  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		const backend = createResolverBackend(resolverMod, { wofPaths, candidateDb })
		const resolver = createWOFResolver(backend)

		// Same discipline for the model weights. `@mailwoman/neural-weights-en-us` is a declared dependency of
		// this package as of 2026-08-03 — before that a standalone `npm install @mailwoman/mcp` resolved
		// nothing and every core-backed tool answered with `resolveWeights`' raw not-found text. The guard keeps
		// that text (it already names the exact fix command) and adds what an agent mid-conversation needs next:
		// which tools are down and which are not.
		let classifier: NeuralAddressClassifier

		try {
			classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
		} catch (error) {
			throw new Error(
				`✗ ${error instanceof Error ? error.message : String(error)}\n\n` +
					`  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

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
 * `plausibilityCheck`'s geocode dep — reuses the SAME shared classifier+resolver `deps.geocode` builds from (see the
 * module header's laziness note). `deriveGeocodeRegister`/the formatted register is the geocode dep's concern, so it is
 * wired at this CLI/MCP layer rather than inside `plausibility.ts`. The real return type (`GeocodeResult`) is
 * structurally assignable to `plausibility.ts`'s minimal `GeocodeLike` — no adapter needed.
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
		// Decision 6: `mailwoman_bdc_filing_landscape` requires bdc.db unconditionally (no optional-dep
		// abstain shape exists for this tool), so a missing file becomes a friendly thrown Error naming the layer —
		// never the raw `node:sqlite` "unable to open database file" message.
		assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", q.databasePath)

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

	async filerLookup(q) {
		// Decision 6/gate 4: filerLookup has no optional-dep abstain shape — it throws rather than
		// answer unstamped — so filer.db is required unconditionally, same discipline as bdc.db is for
		// mailwoman_bdc_filing_landscape.
		assertFilerDatabaseExists("mailwoman_filer_lookup", q.databasePath)

		using db = openFilerDatabaseIfPresent(q.databasePath)!

		let frn: FRN | undefined

		if (q.frn !== undefined) {
			const parsed = toFRN(q.frn)

			if (!parsed) {
				throw new Error(`mailwoman_filer_lookup: "${q.frn}" is not a valid FRN`)
			}

			frn = parsed
		}

		return filerLookup(db, {
			frn,
			form499ID: q.form499ID,
			bdcProviderID: q.bdcProviderID,
			asOf: q.asOf,
		})
	},

	async filerFamily(q) {
		// Same discipline as mailwoman_filer_lookup — familyRollup has no optional-dep abstain shape
		// either, so filer.db is required unconditionally.
		assertFilerDatabaseExists("mailwoman_filer_family", q.databasePath)

		using db = openFilerDatabaseIfPresent(q.databasePath)!

		return familyRollup(db, {
			familyID: q.familyID,
			nodeID: q.nodeID,
			asOf: q.asOf,
		})
	},
}

const server = createMCPServer(deps)
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

await server.connect(new StdioServerTransport())
