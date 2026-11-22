#!/usr/bin/env node
// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   `mailwoman-photon` — boot a Photon-compatible autocomplete endpoint via the `serve`
 *   command, wiring `/api` over `geocodeAddress` (parse → resolve) and `/reverse` over
 *   `WOFReverseGeocoder` into Photon's GeoJSON FeatureCollection.
 */

import { serveNode } from "@mailwoman/api-kit"
import { matchCountry } from "@mailwoman/codex/country"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import {
	corsBannerLine,
	gazetteerBannerLines,
	openAPICommand,
	readListenPort,
	runDropInCLI,
} from "mailwoman/cli/kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli/kit/engine-stamp"
import { unattachedLayerLines } from "mailwoman/geocode/serving-layers"
import { titleCase } from "spliterator"

import { openPhotonGeocoder } from "#cli/geocoder"
import {
	createPhotonApp,
	PHOTON_DOC_INFO,
	photonCollection,
	photonFeature,
	photonForwardCollection,
	type PhotonForwardInput,
	photonOSMTags,
	type PhotonEngine,
	type PhotonProperties,
} from "#index"
import { createLocalityPostcodeLookup } from "#locality-postcode"

/**
 * WOF placetype → Photon property key.
 */
const PLACETYPE_TO_KEY: Record<string, keyof PhotonProperties> = {
	street: "street",
	locality: "city",
	localadmin: "city",
	county: "county",
	region: "state",
	country: "country",
}

/**
 * A real address fits comfortably.
 *
 * Longer input is malformed and would exceed the model's window.
 */
const MAX_QUERY_LEN = 512

const BINARY_NAME = "mailwoman-photon"

async function serve(engineStamp: ResolvedEngineStamp): Promise<void> {
	const { values } = parseArguments({
		options: {
			port: { type: "string", default: "2322" },
			host: { type: "string", default: "0.0.0.0" },
			"candidate-db": { type: "string" },
			// Permissive CORS is on by default for upstream Photon parity; `--no-cors` turns it off
			// where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
		allowPositionals: true,
	})

	const port = readListenPort(values.port)
	const host = values.host ?? "0.0.0.0"

	const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")
	const { gazetteer, rooftops, geocode } = await openPhotonGeocoder(values["candidate-db"] ?? null)
	const { adminDBPath } = gazetteer
	const postcodeOfLocality = await createLocalityPostcodeLookup()
	const reverseGeo = adminDBPath ? new WOFReverseGeocoder({ adminDBPath }) : null

	const engine: PhotonEngine = {
		async search(params) {
			const query = params.q?.trim()

			if (!query || query.length > MAX_QUERY_LEN) return photonCollection([])
			// Forward the client's viewport as a proximity bias, a soft re-rank the resolver
			// folds into candidate scoring, only when both coords are present.
			const bias = params.lat != null && params.lon != null ? [{ lat: params.lat, lon: params.lon }] : undefined

			const result = await geocode(query, bias)

			if (result.lat == null || result.lon == null) return photonCollection([])
			// Decorate from the resolved place using proper-cased ancestry names,
			// the resolved country and osm_key/value/type.
			// Include state/county only on an ancestry-capable backend.
			const country = matchCountry(result.countryCode)

			// A rooftop or interpolated tier is house-grade: include the parsed housenumber
			// and street so photonForwardProperties decorates it `type: house`
			// rather than the admin locality's `type: city`.
			const houseGrade =
				result.resolution_tier === "address_point" ||
				result.resolution_tier === "interpolated" ||
				result.resolution_tier === "plus_code"

			// The street-centroid tier is street-grade: the full assembled street name
			// in `name` plus highway/street osm tags.
			const streetGrade = result.resolution_tier === "street"

			// The register row's own locality decorates a house-grade answer whose hierarchy
			// has no locality, title-cased because extracts store no display-cased locality.
			const places = result.hierarchy.map((h) => ({ tag: h.tag, name: h.name }))

			if (result.rooftop?.localityNorm && !places.some((p) => p.tag === "locality")) {
				places.push({ tag: "locality", name: titleCase(result.rooftop.localityNorm) })
			}

			// Locality→postcode enrichment: an admin answer whose containing postcode is
			// unambiguous (exactly one, keyed by the resolved place's WOF ID) includes it.
			// A multi-postcode city gets no postcode.
			let enrichedPostcode: string | null = null

			if (!result.postcode && !result.rooftop?.postcode) {
				const localityID = result.hierarchy.find(
					(h) => (h.tag === "locality" || h.tag === "localadmin") && h.placeID?.startsWith("wof:")
				)?.placeID

				if (localityID) {
					enrichedPostcode = postcodeOfLocality(Number(localityID.slice(4)), result.countryCode)
				}
			}

			const primary: PhotonForwardInput = {
				lat: result.lat,
				lon: result.lon,
				postcode: result.postcode ?? result.rooftop?.postcode ?? enrichedPostcode,
				country: country ? { name: country.canonical, code: country.iso2 } : null,
				places,
				...(houseGrade ? { house: { number: result.house_number, street: result.street } } : {}),
				...(streetGrade ? { street: { name: result.street } } : {}),
				coordinateSource: result.coordinate_source,
			}

			// candidates[0] is the primary.
			// Its ranked alternatives become extra features up to the requested `limit`.
			const alternatives = result.candidates.slice(1).map((c) => {
				const cc = matchCountry(c.countryCode)

				return {
					lat: c.lat,
					lon: c.lon,
					country: cc ? { name: cc.canonical, code: cc.iso2 } : null,
					places: [{ tag: c.tag, name: c.name }],
				}
			})

			return photonForwardCollection({ primary, alternatives }, params.limit)
		},

		async reverse(params) {
			if (!reverseGeo) return photonCollection([])
			const { hierarchy } = await reverseGeo.reverseGeocode(params.lat, params.lon)

			if (!hierarchy.length) return photonCollection([])
			const deepest = hierarchy[0]!

			// Include osm_key/osm_value/type from the deepest placetype so `/reverse` matches `/api`'s schema.
			const properties: PhotonProperties = {
				name: deepest.name,
				countrycode: deepest.country?.toLowerCase(),
				...photonOSMTags(deepest.placetype),
			}

			for (const place of hierarchy) {
				const key = PLACETYPE_TO_KEY[place.placetype]

				if (key && properties[key] == null) {
					properties[key] = place.name
				}
			}

			return photonCollection([photonFeature(deepest.lon, deepest.lat, properties)])
		},
	}

	const app = createPhotonApp(engine, { cors: values.cors, engine: engineStamp.stamp })

	await serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: (info) => {
			console.error(`[@mailwoman/photon] listening on http://${host}:${info.port}`)

			for (const line of [...gazetteerBannerLines(gazetteer), ...unattachedLayerLines(rooftops)]) {
				console.error(line)
			}

			console.error(corsBannerLine(values.cors))
			console.error(`  endpoints: GET /  GET /api  GET /reverse  GET /openapi.json`)
		},
	})
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi: openAPICommand(BINARY_NAME, createPhotonApp, PHOTON_DOC_INFO, {}),
	serve,
	usage: [
		"  serve [--port 2322] [--host 0.0.0.0] [--candidate-db <path>] [--no-cors]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
