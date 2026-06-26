#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-nominatim` — boot a Nominatim-compatible endpoint via the `serve` command. Usage +
 *   examples live in the package README.
 *
 *   Wires the real engine: `/search` over `geocodeAddress` (parse → resolve), `/reverse` over
 *   `WofReverseGeocoder` (point-in-polygon over WOF admin polygons), reusing the same
 *   resolver-backend selector GeocodeRouter uses. The `annotations` block is empty until the
 *   annotations layer lands.
 */

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"
import express from "express"
import { geocodeAddress, type GeocodeResult, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDbPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"
import { existsSync } from "node:fs"
import { parseArgs } from "node:util"
import {
	createNominatimRouter,
	type NominatimAddressDetails,
	type NominatimEngine,
	type ResolvedAddress,
	toNominatimResult,
} from "./index.js"

/** WOF placetype → Nominatim address key. */
const PLACETYPE_TO_KEY: Record<string, keyof NominatimAddressDetails> = {
	venue: "road",
	street: "road",
	locality: "city",
	localadmin: "city",
	borough: "city_district",
	neighbourhood: "suburb",
	county: "county",
	region: "state",
	macroregion: "state",
	country: "country",
}

function joinNonEmpty(...parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join(", ")
}

/** Map a forward geocode result (admin + coordinate) into the formatter's neutral shape. */
function forwardToResolved(r: GeocodeResult): ResolvedAddress {
	const address: NominatimAddressDetails = {}
	if (r.locality) address.city = r.locality
	if (r.region) address.state = r.region
	if (r.postcode) address.postcode = r.postcode
	for (const h of r.hierarchy) {
		if (h.tag === "country") address.country = h.value
	}
	return {
		lat: r.lat,
		lon: r.lon,
		address,
		displayName: joinNonEmpty(address.city, address.state, address.postcode, address.country) || r.input,
	}
}

async function serve(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "8080" },
			host: { type: "string", default: "0.0.0.0" },
			data: { type: "string" },
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 8080
	const host = values.host ?? "0.0.0.0"

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const wofPaths = wofShardPaths().filter(existsSync)
	const adminDbPath = wofPaths[0]

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const backend = createResolverBackend(resolverMod, { wofPaths })
	const resolver = createWofResolver(backend as unknown as ResolverBackend)
	const shards = new ShardProvider(resolverMod, mailwomanDataRoot())
	const defaultCountry = resolveCandidateDbPath() ? undefined : "US"
	const reverseGeo = adminDbPath ? new resolverMod.WofReverseGeocoder({ adminDbPath }) : undefined

	const engine: NominatimEngine = {
		async search(params) {
			const query =
				params.q ?? joinNonEmpty(params.street, params.city, params.state, params.postalcode, params.country)
			if (!query) return []
			const result = await geocodeAddress(query, { classifier, resolver, shards: shards.for, defaultCountry })
			if (result.lat == null) return []
			return [toNominatimResult(forwardToResolved(result), { addressdetails: params.addressdetails })].slice(
				0,
				params.limit
			)
		},

		async reverse(params) {
			if (!reverseGeo) return null
			const { hierarchy } = await reverseGeo.reverseGeocode(params.lat, params.lon)
			if (hierarchy.length === 0) return null
			const address: NominatimAddressDetails = {}
			for (const place of hierarchy) {
				const key = PLACETYPE_TO_KEY[place.placetype]
				if (key && !address[key]) address[key] = place.name
			}
			const deepest = hierarchy[0]!
			if (deepest.country) address.country_code = deepest.country.toLowerCase()
			const resolved: ResolvedAddress = {
				lat: params.lat,
				lon: params.lon,
				address,
				displayName: hierarchy.map((p) => p.name).join(", "),
				placeId: deepest.id,
				boundingbox: deepest.bbox
					? [
							String(deepest.bbox.minLat),
							String(deepest.bbox.maxLat),
							String(deepest.bbox.minLon),
							String(deepest.bbox.maxLon),
						]
					: undefined,
			}
			return toNominatimResult(resolved, { addressdetails: params.addressdetails })
		},

		async status() {
			return { status: 0, message: "OK" }
		},
	}

	express()
		.use(createNominatimRouter(engine))
		.listen(port, host, () => {
			console.error(`[@mailwoman/nominatim] listening on http://${host}:${port}`)
			console.error(`  wof: ${adminDbPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`)
			console.error(`  endpoints: GET /search  GET /reverse  GET /lookup  GET /status`)
		})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		await serve()
		break
	default:
		console.error("Usage: mailwoman-nominatim serve [--port 8080] [--host 0.0.0.0] [--data <path>]")
		process.exit(command ? 1 : 0)
}
