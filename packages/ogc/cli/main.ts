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
import type { LayerTerms } from "@mailwoman/core/layers/provenance"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { parseObligationRefusals } from "@mailwoman/license/refusals"
import {
	PostcodePlaceBrowser,
	wofDatabaseHoldsPostcodes,
} from "@mailwoman/resolver-wof-sqlite/candidate/postcode-browse"
import { WOFPlaceBrowser } from "@mailwoman/resolver-wof-sqlite/lookup/browse"
import {
	corsBannerLine,
	type GazetteerPaths,
	gazetteerBannerLines,
	gazetteerFreshness,
	openAPICommand,
	readListenPort,
	runDropInCLI,
} from "mailwoman/cli/kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli/kit/engine-stamp"
import { readSourceLocations, type SourceLocations } from "mailwoman/data/source-locations"
import { $public } from "mailwoman/env"
import { type ArtifactFreshness, ManifestState, readFreshness } from "mailwoman/freshness"

import { openOGCGeocoder } from "#cli/geocoder"
import {
	type AncestorsOf,
	createOGCApp,
	geocodeSearchHits,
	OGC_COLLECTION_CATALOG,
	OGC_DEFAULT_PORT,
	OGC_DOC_INFO,
	OGCCollectionID,
	type OGCEngine,
	itemsRefusal,
	type OGCItemSource,
	type OGCServedCollection,
	placeItemSource,
	regionLayerFiles,
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
function layerTermsOf(artifact: ArtifactFreshness): LayerTerms {
	return {
		name: artifact.version?.split("@")[0] ?? artifact.name,
		license: artifact.license,
		attribution: artifact.attribution,
		source: artifact.sources?.[0] ?? null,
	}
}

/**
 * The manifest terms of the region files each street-tier collection reads,
 * and its regions without a readable manifest.
 *
 * A collection lists a layer's terms once, whatever the count of regions that
 * record the same license and source.
 * A file whose `layer_manifest` is absent or unreadable contributes no terms,
 * and its region is counted as unread.
 *
 * @param sourceLocations Every owner's source table, under the provider's own table for each file.
 */
async function regionLayerTerms(
	probes: readonly RegionLayerProbe[],
	sourceLocations: SourceLocations["table"]
): Promise<Map<OGCCollectionID, Pick<OGCServedCollection, "layers" | "unreadRegions">>> {
	const files = regionLayerFiles(probes)
	const paths = [...new Set(files.map(({ path }) => path))]
	const { artifacts } = await readFreshness(paths.map((path) => ({ name: path, path })))
	const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]))
	const terms = new Map<OGCCollectionID, { layers: Map<string, LayerTerms>; unread: Set<string> }>()

	for (const file of files) {
		const entry = terms.get(file.collection) ?? { layers: new Map(), unread: new Set() }
		const artifact = byPath.get(file.path)

		terms.set(file.collection, entry)

		if (artifact?.manifest !== ManifestState.Present) {
			entry.unread.add(file.region)

			continue
		}

		const layer = { ...layerTermsOf(artifact), sourceLocations: { ...sourceLocations, ...file.sourceLocations } }
		const key = `${layer.license} ${layer.source?.split(":")[0]} ${layer.attribution}`

		if (!entry.layers.has(key)) {
			entry.layers.set(key, layer)
		}
	}

	return new Map(
		[...terms].map(([collection, { layers, unread }]) => [
			collection,
			{ layers: [...layers.values()], ...(unread.size ? { unreadRegions: unread.size } : {}) },
		])
	)
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
	const refusal = itemsRefusal(license, parseObligationRefusals([$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""]))

	if (refusal) {
		return { source: null, bannerLines: [`  places items: none, because ${refusal} in ${adminDBPath}`] }
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

/**
 * Whether the gazetteer holds postcode places, and the `postcodes` collection's item source.
 */
interface PostcodeItems {
	held: boolean
	source: OGCItemSource | null
	bannerLines: string[]
}

/**
 * Read whether the gazetteer `/search` resolves against holds postcode places, and open the
 * candidate gazetteer as the `postcodes` collection's item source when the operator asked for items.
 *
 * The candidate gazetteer holds the postcode places when the server resolves against it.
 * Otherwise they come from the WOF databases it opened.
 * Those databases serve no items.
 *
 * The obligation refusal applies as it does to `places`, from the candidate gazetteer's recorded license.
 */
function openPostcodeItems(
	serveItems: boolean,
	gazetteer: GazetteerPaths,
	candidate: ArtifactFreshness | undefined,
	ancestorsOf: AncestorsOf | undefined
): PostcodeItems {
	if (!gazetteer.candidateDB) {
		const held = gazetteer.wofPaths.some((path) => wofDatabaseHoldsPostcodes(path))

		return {
			held,
			source: null,
			bannerLines: serveItems && held ? ["  postcodes items: none, because no candidate gazetteer was opened"] : [],
		}
	}

	let browser: PostcodePlaceBrowser

	try {
		browser = new PostcodePlaceBrowser({ databasePath: gazetteer.candidateDB })
	} catch (error) {
		// The gazetteer records postcode places but can't page them, so `/search` still answers postcodes.
		return {
			held: true,
			source: null,
			bannerLines: serveItems
				? [
						`  postcodes items: none, because ${gazetteer.candidateDB} can't be paged: ${error instanceof Error ? error.message : String(error)}`,
					]
				: [],
		}
	}

	const held = browser.holdsPostcodes()

	if (!serveItems || !held) {
		browser[Symbol.dispose]()

		return { held, source: null, bannerLines: [] }
	}

	const license = candidate?.license ?? null
	const refusal = itemsRefusal(license, parseObligationRefusals([$public.MAILWOMAN_REFUSE_OBLIGATIONS ?? ""]))

	if (refusal) {
		browser[Symbol.dispose]()

		return {
			held,
			source: null,
			bannerLines: [`  postcodes items: none, because ${refusal} in ${gazetteer.candidateDB}`],
		}
	}

	return {
		held,
		source: placeItemSource(browser, ancestorsOf),
		bannerLines: [`  postcodes items: ${gazetteer.candidateDB} (${license ?? "license unrecorded in layer_manifest"})`],
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

	const port = readListenPort(values.port)
	const host = values.host ?? "0.0.0.0"
	const baseURL = values["base-url"]

	const { gazetteer, session, geocode } = await openOGCGeocoder(values["candidate-db"] ?? null)
	// The session owns the gazetteer backend and every provider read below, and closes them with itself.
	const { lookup, regionDatabases, nationalSources, osm } = session.services
	// The gazetteer's own ancestry reader labels each place match with its region and county.
	const ancestorsOf = lookup.ancestors?.bind(lookup)
	const countries = worldCountries()
	const countryCodeOf = (code: string): string => code.toUpperCase()

	const probes: RegionLayerProbe[] = [
		// The region provider's keys are the ISO 3166-2 codes of the regions it has a file for.
		{ provider: regionDatabases, keys: regionDatabases.regions(), regionOf: countryCodeOf },
		...nationalSources.map((provider) => ({ provider, keys: countries, regionOf: countryCodeOf })),
		...(osm ? [{ provider: osm, keys: countries, regionOf: countryCodeOf }] : []),
	]

	// The manifests of the gazetteer databases this process opened: the ones `/search` reads,
	// and the admin gazetteer they derive from.
	// The admin gazetteer also serves the `places` items.
	const { artifacts } = await gazetteerFreshness(gazetteer)
	const admin = artifacts.find((artifact) => artifact.path === gazetteer.adminDBPath)
	const searchLayers = artifacts.filter((artifact) => artifact.name !== "reverse-admin").map(layerTermsOf)
	const placeLayers = artifacts.map(layerTermsOf)
	const placeItems = await openPlaceItems(values["serve-items"], admin, ancestorsOf)
	const candidate = artifacts.find((artifact) => artifact.path === gazetteer.candidateDB)
	const postcodeItems = openPostcodeItems(values["serve-items"], gazetteer, candidate, ancestorsOf)

	const itemsOf = (id: OGCCollectionID): OGCItemSource | null => {
		if (id === OGCCollectionID.Places) return placeItems.source

		if (id === OGCCollectionID.Postcodes) return postcodeItems.source

		return null
	}

	// The gazetteer collections read the manifests above, and the address and street
	// collections read the manifests of the region files their providers report.
	// Plus codes have no layer.
	const regional = await regionLayerTerms(probes, (await readSourceLocations()).table)

	const layersOf = (id: OGCCollectionID): Pick<OGCServedCollection, "layers" | "unreadRegions"> => {
		switch (id) {
			case OGCCollectionID.Places:
				return { layers: placeLayers }
			case OGCCollectionID.Postcodes:
				return { layers: searchLayers }
			case OGCCollectionID.PlusCodes:
				return { layers: [] }
			case OGCCollectionID.Addresses:
			case OGCCollectionID.Streets:
				return regional.get(id) ?? { layers: [] }
		}
	}

	const engine: OGCEngine = {
		collections: servedCollections(probes, { postcodes: postcodeItems.held }).map((collection) => {
			const items = itemsOf(collection.id)

			return { ...collection, ...layersOf(collection.id), ...(items ? { items } : {}) }
		}),
		async search(q) {
			return geocodeSearchHits(await geocode(q), ancestorsOf)
		},
	}

	const app = createOGCApp(engine, {
		cors: values.cors,
		engine: engineStamp.stamp,
		baseURL,
		serveItems: placeItems.source != null || postcodeItems.source != null,
	})

	await serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: (info) => {
			console.error(`[@mailwoman/ogc] listening on http://${host}:${info.port}`)
			console.error(`  base URL: ${baseURL ?? "(the request's own origin)"}`)

			for (const line of gazetteerBannerLines(gazetteer)) {
				console.error(line)
			}

			for (const { id, regions, items } of engine.collections) {
				console.error(
					`  collection ${id}: ${regions ? regions.join(" ") : "worldwide"}${items ? ", serves items" : ""}`
				)
			}

			for (const line of [...placeItems.bannerLines, ...postcodeItems.bannerLines]) {
				console.error(line)
			}

			const itemRoutes = engine.collections
				.filter(({ items }) => items)
				.map(({ id }) => `  GET /collections/${id}/items  GET /collections/${id}/items/{featureId}`)

			console.error(corsBannerLine(values.cors))
			console.error(
				`  endpoints: GET /  GET /conformance  GET /api  GET /collections  GET /search  GET /openapi.json${itemRoutes.join("")}`
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
