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
 *   resolver-backend selector GeocodeRouter uses. Results carry the OpenCage-style `annotations`
 *   block — coordinate formats, flag, calling code, currency, and (when their DBs are present)
 *   timezone, UN/LOCODE, NUTS — composed from the `@mailwoman/*` annotators.
 */

import { composeAnnotators, toOpenCage } from "@mailwoman/annotations"
import { countryReferenceAnnotator, matchCountry } from "@mailwoman/codex/country"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { makeNutsAnnotator, NutsLookup } from "@mailwoman/nuts-lookup"
import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"
import { coordinateFormatAnnotator } from "@mailwoman/spatial"
import { makeTimezoneAnnotator, TimezoneLookup } from "@mailwoman/timezone-lookup"
import { makeUnLocodeAnnotator, UnLocodeLookup } from "@mailwoman/un-locode-lookup"
import express from "express"
import { geocodeAddress, type GeocodeResult, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDbPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"
import { existsSync } from "node:fs"
import { join } from "node:path"
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
	// NOT a geocode country constraint. The default-on #244 placer already routes the query's country
	// (Berlin→DE, Boston→US) and `defaultCountry` is a HARD override that beats it (geocode-core.ts:102),
	// so forcing "US" resolved every non-US query to its US namesake (Berlin→Berlin NH). We let the
	// placer decide instead. This is the fallback used ONLY to annotate the flag/currency/calling-code
	// when the resolved hierarchy omits the country tag — which on US-centric data (no candidate DB)
	// happens for US results, where "US" is the right guess. Non-US results carry the country tag, so
	// the fallback never mislabels them.
	const annotationCountryFallback = resolveCandidateDbPath() ? undefined : "US"
	const reverseGeo = adminDbPath ? new resolverMod.WofReverseGeocoder({ adminDbPath }) : undefined
	const annotators = [coordinateFormatAnnotator, countryReferenceAnnotator]
	const tzDbPath = join(mailwomanDataRoot(), "timezone", "timezone.db")
	if (existsSync(tzDbPath)) annotators.push(makeTimezoneAnnotator(new TimezoneLookup({ databasePath: tzDbPath })))
	const ulDbPath = join(mailwomanDataRoot(), "un-locode", "un-locode.db")
	if (existsSync(ulDbPath)) annotators.push(makeUnLocodeAnnotator(new UnLocodeLookup({ databasePath: ulDbPath })))
	const nutsDbPath = join(mailwomanDataRoot(), "nuts", "nuts.db")
	if (existsSync(nutsDbPath)) annotators.push(makeNutsAnnotator(new NutsLookup({ databasePath: nutsDbPath })))
	const annotate = composeAnnotators(annotators)

	const engine: NominatimEngine = {
		async search(params) {
			const query =
				params.q ?? joinNonEmpty(params.street, params.city, params.state, params.postalcode, params.country)
			if (!query) return []
			const result = await geocodeAddress(query, { classifier, resolver, shards: shards.for })
			if (result.lat == null || result.lon == null) return []
			const out = toNominatimResult(forwardToResolved(result), { addressdetails: params.addressdetails })
			// Country tag isn't always in the hierarchy (US admin results omit it); fall back to the
			// US-centric-data default so US results still get a flag / calling code / currency.
			const countryName = result.hierarchy.find((h) => h.tag === "country")?.value ?? annotationCountryFallback
			const countryCode = matchCountry(countryName)?.iso2
			out.annotations = toOpenCage(
				await annotate({ lat: result.lat, lon: result.lon, countryCode, placeName: result.locality ?? undefined })
			)
			return [out].slice(0, params.limit)
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
			const out = toNominatimResult(resolved, { addressdetails: params.addressdetails })
			out.annotations = toOpenCage(
				await annotate({ lat: params.lat, lon: params.lon, countryCode: address.country_code })
			)
			return out
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
