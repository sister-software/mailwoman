#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { filingLandscape, plausibilityCheck, type BDCDatabase } from "@mailwoman/bdc"
import type { PipelineResult } from "@mailwoman/core"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { readLayerManifest, type layerschemadatabase } from "@mailwoman/core/layers"
import type { Resolver } from "@mailwoman/core/resolver"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { familyRollup } from "@mailwoman/filer/family-rollup"
import { filerLookup } from "@mailwoman/filer/filer-lookup"
import { toFRN, type FRN } from "@mailwoman/filer/frn"
import { NeuralAddressClassifier, type ScriptRoutedClassifier } from "@mailwoman/neural"
import { getPOICategory } from "@mailwoman/poi-taxonomy"
import { emitOverpassQL } from "@mailwoman/poi-taxonomy/overpass"
import { createWOFResolver } from "@mailwoman/resolver"
import { wofExtractPaths } from "@mailwoman/resolver-wof-sqlite/paths"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { createRuntimePipeline } from "mailwoman"
import { geocodeAddress, RegionDatabaseProvider } from "mailwoman/geocode"
import { buildNoGazetteerMessage, createResolverBackend, resolveCandidateDBPath } from "mailwoman/resolver-backend"

import {
	assertBDCDatabaseExists,
	assertFilerDatabaseExists,
	openBDCDatabaseIfPresent,
	openFilerDatabaseIfPresent,
	openPlausibilityPOIDeps,
} from "#layer-guards"
import { createMCPServer } from "#server"
import type { MCPToolDeps } from "#tools"

const { values } = parseArguments({
	options: {
		"poi-db": { type: "string" },
	},
	allowPositionals: true,
})

const poiDatabasePath = values["poi-db"]

let corePromise:
	| Promise<{
			classifier: ScriptRoutedClassifier<NeuralAddressClassifier>
			resolver: Resolver
			databases: RegionDatabaseProvider
	  }>
	| undefined

const CORE_BACKED_TOOLS = "mailwoman_parse, mailwoman_geocode, mailwoman_poi_search, mailwoman_overpass_export"

const CORE_FREE_TOOLS =
	"mailwoman_layer_manifest, mailwoman_bdc_filing_landscape, mailwoman_filer_lookup, mailwoman_filer_family"

function loadCore(): Promise<{
	classifier: ScriptRoutedClassifier
	resolver: Resolver
	databases: RegionDatabaseProvider
}> {
	corePromise ??= (async () => {
		const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
		const wofPaths: string[] = []

		for (const extractPath of wofExtractPaths()) {
			if (await pathExists(extractPath)) {
				wofPaths.push(extractPath)
			}
		}

		const candidateDB = await resolveCandidateDBPath()

		if (!candidateDB && !wofPaths.length) {
			throw new Error(
				`${buildNoGazetteerMessage({
					dataRoot: dataRootPath(),
					docsPath: "/docs/developers/how-to/use-the-mcp-server",
				})}\n\n  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
		const resolver = createWOFResolver(backend)

		let classifier: ScriptRoutedClassifier<NeuralAddressClassifier>

		try {
			classifier = await NeuralAddressClassifier.loadRoutedFromWeights({ locale: "en-US" })
		} catch (error) {
			throw new Error(
				`✗ ${error instanceof Error ? error.message : String(error)}\n\n` +
					`  Needs it: ${CORE_BACKED_TOOLS}\n  Works without it: ${CORE_FREE_TOOLS}`
			)
		}

		const databases = await RegionDatabaseProvider.create(resolverMod, dataRootPath())

		return { classifier, resolver, databases }
	})()

	return corePromise
}

type Pipeline = (raw: string) => Promise<PipelineResult>

let plainPipeline: Pipeline | undefined

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

async function resolveGeocode(address: string) {
	const { classifier, resolver, databases } = await loadCore()

	return geocodeAddress(address, { classifier, resolver, databases: databases.for })
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

		const osmTags =
			subject.kind === "category"
				? subject.categoryIDs.map((id) => getPOICategory(id)?.osmTag).filter((tag) => tag !== undefined)
				: []

		return emitOverpassQL(
			outcome.intent,
			subject.kind === "category" && osmTags.length === subject.categoryIDs.length ? { osmTags } : {}
		)
	},

	async layerManifest(databasePath) {
		using db = new DatabaseClient<layerschemadatabase>(databasePath, { readOnly: true })

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
		await assertBDCDatabaseExists("mailwoman_bdc_filing_landscape", q.databasePath)

		using db = new DatabaseClient<BDCDatabase>(q.databasePath, { readOnly: true })

		return filingLandscape(db, { geoids: q.geoids, h3Cells: q.h3Cells })
	},

	async plausibilityCheck(q) {
		const bdcDB = await openBDCDatabaseIfPresent(q.bdcDatabasePath)
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
			poi?.schemadb.destroy()
		}
	},

	async filerLookup(q) {
		await assertFilerDatabaseExists("mailwoman_filer_lookup", q.databasePath)

		using db = (await openFilerDatabaseIfPresent(q.databasePath))!

		let frn: FRN | undefined

		if (q.frn !== undefined) {
			const parsed = toFRN(q.frn)

			if (!parsed) {
				throw new Error(`mailwoman_filer_lookup: "${q.frn}" is not a valid FRN`)
			}

			frn = parsed
		}

		return await filerLookup(db, {
			frn,
			form499ID: q.form499ID,
			bdcProviderID: q.bdcProviderID,
			asOf: q.asOf,
		})
	},

	async filerFamily(q) {
		await assertFilerDatabaseExists("mailwoman_filer_family", q.databasePath)

		using db = (await openFilerDatabaseIfPresent(q.databasePath))!

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
