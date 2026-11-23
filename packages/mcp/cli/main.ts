#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { filingLandscape, plausibilityCheck, type BDCDatabase } from "@mailwoman/bdc"
import { readLayerManifest, type layerschemadatabase } from "@mailwoman/core/layers"
import { isPresent } from "@mailwoman/core/objects"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { familyRollup } from "@mailwoman/filer/family-rollup"
import { filerLookup } from "@mailwoman/filer/filer-lookup"
import { toFRN, type FRN } from "@mailwoman/filer/frn"
import { getPOICategory } from "@mailwoman/poi-taxonomy"
import { emitOverpassQL } from "@mailwoman/poi-taxonomy/overpass"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { createRuntimePipeline, type RuntimePipeline } from "mailwoman/engine/runtime-pipeline"

import { closeCore, geocodeRunThroughCore, geocodeThroughCore, loadCore } from "#cli/core"
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

const poiDatabasePath = values["poi-db"] ?? null

let plainPipeline: RuntimePipeline | null = null

const poiPipelines = new Map<string, RuntimePipeline>()

async function getPlainPipeline(): Promise<RuntimePipeline> {
	if (!plainPipeline) {
		const { classifier, resolver } = await loadCore()

		plainPipeline = createRuntimePipeline({ classifier, resolver })
	}

	return plainPipeline
}

async function getPoiPipeline(dbPath: string | null): Promise<RuntimePipeline> {
	const key = dbPath ?? ""
	const cached = poiPipelines.get(key)

	if (cached) return cached
	const { classifier, resolver } = await loadCore()

	const pipeline = createRuntimePipeline({
		classifier,
		resolver,
		poiQueryKind: dbPath ? { poiDatabasePath: dbPath } : "extract",
	})

	poiPipelines.set(key, pipeline)

	return pipeline
}

const deps: MCPToolDeps = {
	async parse(text, opts) {
		const pipeline = opts?.poi ? await getPoiPipeline(poiDatabasePath) : await getPlainPipeline()

		return pipeline(text)
	},

	async geocode(text, opts) {
		const { result, applied } = await geocodeRunThroughCore(text, opts?.parent ?? null)

		// The tool states the locale and country scope behind the answer, so an agent can tell a default decided it.
		return { ...result, applied }
	},

	async poiSearch(q) {
		const pipeline = await getPoiPipeline(q.poiDatabasePath ?? poiDatabasePath)
		const result = await pipeline(q.query)

		return result.poiIntent ?? { type: "abstain", reason: "not_poi_shaped" }
	},

	async overpassExport(query) {
		const pipeline = await getPoiPipeline(poiDatabasePath)
		const result = await pipeline(query)
		const poiIntent = result.poiIntent

		if (!poiIntent || poiIntent.type !== "intent") {
			const reason = poiIntent?.type === "abstain" ? `: ${poiIntent.reason}` : ""

			throw new Error(
				`mailwoman_overpass_export: query is not POI-shaped (${poiIntent?.type ?? "no poi intent"}${reason})`
			)
		}

		const { subject } = poiIntent.intent

		const osmTags =
			subject.kind === "category"
				? subject.categoryIDs.map((id) => getPOICategory(id)?.osmTag).filter((tag) => typeof tag === "string")
				: []

		return emitOverpassQL(
			poiIntent.intent,
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

		return await filingLandscape(db, {
			geoids: q.geoids ?? undefined,
			h3Cells: q.h3Cells ?? undefined,
		})
	},

	async plausibilityCheck(q) {
		const bdcDB = await openBDCDatabaseIfPresent(q.bdcDatabasePath ?? undefined)
		const poi = await openPlausibilityPOIDeps(q.poiDatabasePath ?? undefined)

		try {
			return await plausibilityCheck(
				{
					address: q.address ?? undefined,
					point: q.point ?? undefined,
					geoid: q.geoid ?? undefined,
					technologyCode: q.technologyCode,
					claimedDownloadMbps: q.claimedDownloadMbps,
				},
				{ bdcDB, poi, geocode: geocodeThroughCore }
			)
		} finally {
			bdcDB?.destroy()
			poi?.schemadb.destroy()
		}
	},

	async filerLookup(q) {
		await assertFilerDatabaseExists("mailwoman_filer_lookup", q.databasePath)

		using db = (await openFilerDatabaseIfPresent(q.databasePath))!

		let frn: FRN | null = null

		if (q.frn != null) {
			const parsed = toFRN(q.frn)

			if (!parsed) {
				throw new Error(`mailwoman_filer_lookup: "${q.frn}" is not a valid FRN`)
			}

			frn = parsed
		}

		return await filerLookup(db, {
			frn,
			form499ID: q.form499ID ?? undefined,
			bdcProviderID: q.bdcProviderID ?? undefined,
			asOf: q.asOf ?? undefined,
		})
	},

	async filerFamily(q) {
		await assertFilerDatabaseExists("mailwoman_filer_family", q.databasePath)

		using db = (await openFilerDatabaseIfPresent(q.databasePath))!

		return await familyRollup(db, {
			familyID: q.familyID ?? undefined,
			nodeID: q.nodeID ?? undefined,
			asOf: q.asOf ?? undefined,
		})
	},
}

const server = createMCPServer(deps)
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js")

let closing = false

/**
 * Closes what the tools opened: each pipeline's scope first, then the session whose resolver they read.
 */
async function shutdown(): Promise<void> {
	if (closing) return

	closing = true

	const pipelines = [plainPipeline, ...poiPipelines.values()].filter(isPresent)

	plainPipeline = null
	poiPipelines.clear()

	for (const pipeline of pipelines) {
		await pipeline[Symbol.asyncDispose]()
	}

	await closeCore()
}

// The client closing its end of the transport ends the server, as a signal does.
server.server.onclose = () => void shutdown()

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => void shutdown().finally(() => process.exit(0)))
}

await server.connect(new StdioServerTransport())
