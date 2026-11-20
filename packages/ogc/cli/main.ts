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
import { WOFPlaceBrowser } from "@mailwoman/resolver-wof-sqlite/browse"
import {
	corsBannerLine,
	gazetteerBannerLines,
	gazetteerFreshness,
	loadClassifierOrExit,
	openAPICommand,
	resolveGazetteerOrExit,
	runDropInCLI,
} from "mailwoman/cli/kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli/kit/engine-stamp"
import { obligationFindings, ObligationRefusal, parseObligationRefusals } from "mailwoman/data/obligations"
import { $public } from "mailwoman/env"
import type { ArtifactFreshness } from "mailwoman/freshness"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import { openServingRooftopProviders } from "mailwoman/geocode/serving-layers"
import { createResolverBackend } from "mailwoman/resolver-backend"

import {
	type AncestorsOf,
	createOGCApp,
	geocodeSearchHits,
	OGC_COLLECTION_CATALOG,
	OGC_DEFAULT_PORT,
	OGC_DOC_INFO,
	OGCCollectionID,
	type OGCEngine,
	type OGCItemSource,
	type OGCLayerTerms,
	placeItemSource,
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

/**
 * The `places` collection's item source and the banner lines that state where it reads and on what terms.
 */
interface PlaceItems {
	source: OGCItemSource | null
	bannerLines: string[]
}

/**
 * The terms an opened artifact's manifest records, under the layer name the manifest gives it.
 *
 * An artifact without a readable manifest keeps the role the server opened it for and records no terms.
 */
function layerTermsOf(artifact: ArtifactFreshness): OGCLayerTerms {
	return {
		name: artifact.version?.split("@")[0] ?? artifact.name,
		license: artifact.license,
		attribution: artifact.attribution,
		source: artifact.sources?.[0] ?? null,
	}
}

/**
 * Open the admin gazetteer as the `places` collection's item source, when the operator asked for items.
 *
 * The items routes serve the gazetteer in pages, so the operator's `MAILWOMAN_REFUSE_OBLIGATIONS`
 * applies to them as it applies to an OpenStreetMap layer: a refused class in the database's
 * recorded license leaves `places` without items, and the banner states the refusal.
 * A database without the `place_bbox` R*Tree can't answer a box page, so it serves no items either.
 */
async function openPlaceItems(
	serveItems: boolean,
	admin: ArtifactFreshness | undefined,
	ancestorsOf: AncestorsOf | undefined
): Promise<PlaceItems> {
	if (!serveItems) {
		return {
			source: null,
			bannerLines: ["  items: off, because bulk browsing is opt-in; pass --serve-items to serve them"],
		}
	}

	if (!admin) {
		return { source: null, bannerLines: ["  places items: none, because no admin gazetteer database was found"] }
	}

	const adminDBPath = admin.path
	const license = admin.license
	const refuse = parseObligationRefusals([$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""])
	const findings = license ? obligationFindings(license, refuse) : []

	if (!license && refuse.includes(ObligationRefusal.Unresolved)) {
		findings.push({
			refusal: ObligationRefusal.Unresolved,
			identifier: "(none)",
			reason: "the database records no license",
		})
	}

	if (findings.length) {
		return {
			source: null,
			bannerLines: [
				`  places items: none, because MAILWOMAN_REFUSE_OBLIGATIONS refuses ${findings.map(({ reason }) => reason).join("; ")} in ${adminDBPath}`,
			],
		}
	}

	try {
		const browser = new WOFPlaceBrowser({ databasePath: adminDBPath })

		return {
			source: placeItemSource(browser, ancestorsOf),
			bannerLines: [`  places items: ${adminDBPath} (${license ?? "license unrecorded in layer_manifest"})`],
		}
	} catch (error) {
		return {
			source: null,
			bannerLines: [
				`  places items: none, because ${adminDBPath} can't be paged: ${error instanceof Error ? error.message : String(error)}`,
			],
		}
	}
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
			// Serve the `places` collection's items for bulk browsing.
			// Off by default.
			"serve-items": { type: "boolean", default: false },
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

	// The manifests of the gazetteer databases this process opened: the ones `/search` reads,
	// and the admin gazetteer they derive from.
	// The admin gazetteer also serves the `places` items.
	const { artifacts } = await gazetteerFreshness(gazetteer)
	const admin = artifacts.find((artifact) => artifact.path === gazetteer.adminDBPath)
	const searchLayers = artifacts.filter((artifact) => artifact.name !== "reverse-admin").map(layerTermsOf)
	const placeLayers = artifacts.map(layerTermsOf)
	const placeItems = await openPlaceItems(values["serve-items"], admin, ancestorsOf)

	// The gazetteer collections read the manifests above.
	// Plus codes have no layer.
	// The address and street layers are opened per region, and the server reads none of their manifests.
	const layersOf = (id: OGCCollectionID): readonly OGCLayerTerms[] | undefined => {
		switch (id) {
			case OGCCollectionID.Places:
				return placeLayers
			case OGCCollectionID.Postcodes:
				return searchLayers
			case OGCCollectionID.PlusCodes:
				return []
			case OGCCollectionID.Addresses:
			case OGCCollectionID.Streets:
				return undefined
		}
	}

	const engine: OGCEngine = {
		collections: servedCollections(probes).map((collection) => {
			const layers = layersOf(collection.id)

			return {
				...collection,
				...(layers ? { layers } : {}),
				...(collection.id === OGCCollectionID.Places && placeItems.source ? { items: placeItems.source } : {}),
			}
		}),
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

	const app = createOGCApp(engine, {
		cors: values.cors,
		engine: engineStamp.stamp,
		baseURL,
		serveItems: placeItems.source != null,
	})

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

			for (const { id, regions, items } of engine.collections) {
				console.error(
					`  collection ${id}: ${regions ? regions.join(" ") : "worldwide"}${items ? ", serves items" : ""}`
				)
			}

			for (const line of placeItems.bannerLines) {
				console.error(line)
			}

			console.error(corsBannerLine(values.cors))
			console.error(
				`  endpoints: GET /  GET /conformance  GET /api  GET /collections  GET /search  GET /openapi.json${
					placeItems.source ? "  GET /collections/places/items  GET /collections/places/items/{featureId}" : ""
				}`
			)
		},
	})
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi: openAPICommand(BINARY_NAME, createOGCApp, OGC_DOC_INFO, DOCUMENTED_ENGINE),
	serve,
	usage: [
		"  serve [--port 8090] [--host 0.0.0.0] [--base-url <url>] [--candidate-db <path>] [--no-cors] [--serve-items]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
