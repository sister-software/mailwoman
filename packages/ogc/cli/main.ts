#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman-ogc` boots the OGC API surface through the `serve` command
 *   and prints its API definition through the `openapi` command.
 *
 *   `serve` wires `/search` over `geocodeAddress` (parse, then resolve) with the same
 *   gazetteer, classifier and rooftop providers the Photon and Nominatim servers attach,
 *   and lists as collections the layers those providers opened.
 */

import { serveNode } from "@mailwoman/api-kit"
import { worldCountries } from "@mailwoman/codex/country/sets"
import { US_STATE_BY_ABBREVIATION } from "@mailwoman/codex/us"
import { dataRootPath } from "@mailwoman/core/data-root"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { createWOFResolver } from "@mailwoman/resolver"
import {
	corsBannerLine,
	gazetteerBannerLines,
	loadClassifierOrExit,
	openAPICommand,
	resolveGazetteerOrExit,
	runDropInCLI,
} from "mailwoman/cli/kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli/kit/engine-stamp"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import { openServingRooftopProviders } from "mailwoman/geocode/serving-layers"
import { createResolverBackend } from "mailwoman/resolver-backend"

import {
	createOGCApp,
	geocodeSearchHits,
	OGC_COLLECTION_CATALOG,
	OGC_DEFAULT_PORT,
	OGC_DOC_INFO,
	type OGCCollectionID,
	type OGCEngine,
	type RegionLayerProbe,
	servedCollections,
} from "#index"

const BINARY_NAME = "mailwoman-ogc"

/**
 * The engine the `openapi` command documents.
 *
 * It lists every collection the surface can serve, so the printed definition
 * declares each collection's `/search` parameters.
 */
const DOCUMENTED_ENGINE: OGCEngine = {
	collections: Object.keys(OGC_COLLECTION_CATALOG).map((id) => ({ id: id as OGCCollectionID, regions: null })),
	search: async () => [],
}

async function serve(engineStamp: ResolvedEngineStamp): Promise<void> {
	const { values } = parseArguments({
		options: {
			port: { type: "string", default: String(OGC_DEFAULT_PORT) },
			host: { type: "string", default: "0.0.0.0" },
			// The public base URL that link hrefs resolve against, for a deployment behind a reverse proxy.
			"base-url": { type: "string" },
			"candidate-db": { type: "string" },
			// Permissive CORS is on by default because OGC API clients run in browsers too.
			// `--no-cors` turns it off where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
		allowPositionals: true,
	})

	const port = Number(values.port) || OGC_DEFAULT_PORT
	const host = values.host ?? "0.0.0.0"
	const baseURL = values["base-url"]

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = await resolveGazetteerOrExit(values["candidate-db"] ?? null)
	const { candidateDB, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
	const resolver = createWOFResolver(backend)
	// The gazetteer's own ancestry reader labels each place match with its region and county.
	const ancestorsOf = backend.ancestors?.bind(backend)
	const extracts = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// The national open register ahead of the OpenStreetMap tier, read from one generation
	// of the active selection, as the Photon and Nominatim servers read them.
	const rooftops = await openServingRooftopProviders(dataRootPath())
	const countries = worldCountries()

	const probes: RegionLayerProbe[] = [
		{
			provider: extracts,
			keys: Object.keys(US_STATE_BY_ABBREVIATION).map((abbreviation) => abbreviation.toLowerCase()),
			regionOf: (slug) => `US-${slug.toUpperCase()}`,
		},
		{ provider: rooftops.national, keys: countries, regionOf: (code) => code.toUpperCase() },
		...(rooftops.osm
			? [{ provider: rooftops.osm, keys: countries, regionOf: (code: string) => code.toUpperCase() }]
			: []),
	]

	const engine: OGCEngine = {
		collections: servedCollections(probes),
		async search(q) {
			// The call sets no country constraint, so the placer routes the query to its own country.
			const result = await geocodeAddress(q, {
				classifier,
				resolver,
				databases: extracts.for,
				nationalDatabases: rooftops.national.for,
				...(rooftops.osm ? { osmDatabases: rooftops.osm.for } : {}),
			})

			return geocodeSearchHits(result, ancestorsOf)
		},
	}

	const app = createOGCApp(engine, { cors: values.cors, engine: engineStamp.stamp, baseURL })

	await serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: () => {
			console.error(`[@mailwoman/ogc] listening on http://${host}:${port}`)
			console.error(`  base URL: ${baseURL ?? "(the request's own origin)"}`)

			for (const line of gazetteerBannerLines(gazetteer)) {
				console.error(line)
			}

			for (const { id, regions } of engine.collections) {
				console.error(`  collection ${id}: ${regions ? regions.join(" ") : "worldwide"}`)
			}

			console.error(corsBannerLine(values.cors))
			console.error(`  endpoints: GET /  GET /conformance  GET /api  GET /collections  GET /search  GET /openapi.json`)
		},
	})
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi: openAPICommand(BINARY_NAME, createOGCApp, OGC_DOC_INFO, DOCUMENTED_ENGINE),
	serve,
	usage: [
		"  serve [--port 8090] [--host 0.0.0.0] [--base-url <url>] [--candidate-db <path>] [--no-cors]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
