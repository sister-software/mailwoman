#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-nominatim`, booting a Nominatim-compatible endpoint through the `serve` command.
 *   Usage and examples live in the package readme.
 *
 *   Wires the real engine: `/search` over `geocodeAddress` and `/reverse` over
 *   `WOFReverseGeocoder` (point-in-polygon over WOF admin polygons), reusing the resolver-backend
 *   selector `GeocodeRouter` uses. Results include the OpenCage-style `annotations` block composed
 *   from the `@mailwoman/*` annotators.
 */

import { composeAnnotators, toOpenCage } from "@mailwoman/annotations"
import { serveNode } from "@mailwoman/api-kit"
import { countryReferenceAnnotator, matchCountry } from "@mailwoman/codex/country"
import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { makeNUTSAnnotator, NUTSLookup } from "@mailwoman/nuts-lookup"
import { createWOFResolver } from "@mailwoman/resolver"
import { coordinateFormatAnnotator } from "@mailwoman/spatial"
import { makeTimezoneAnnotator, TimezoneLookup } from "@mailwoman/timezone-lookup"
import { timezoneDatabasePath } from "@mailwoman/timezone-lookup/paths"
import { makeUNLocodeAnnotator, UNLocodeLookup } from "@mailwoman/un-locode-lookup"
import {
	corsBannerLine,
	gazetteerBannerLines,
	rightsBannerLines,
	gazetteerFreshness,
	loadClassifierOrExit,
	openAPICommand,
	resolveGazetteerOrExit,
	runDropInCLI,
} from "mailwoman/cli-kit/dropin"
import type { ResolvedEngineStamp } from "mailwoman/cli-kit/engine-stamp"
import { geocodeAddress, USStateDatabaseProvider } from "mailwoman/geocode"
import { createResolverBackend } from "mailwoman/resolver-backend"
import { resolvePath } from "path-ts"

import { forwardToResolved } from "#forward-address"
import {
	createNominatimApp,
	type NominatimAddressDetails,
	type NominatimEngine,
	nominatimStatus,
	NOMINATIM_DOC_INFO,
	type ResolvedAddress,
	toNominatimResult,
} from "#index"

/**
 * WOF placetype → Nominatim address key.
 */
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

/**
 * A real address fits comfortably and anything longer is malformed input that
 * would exceed the model's input window.
 *
 * Cap defensively so a giant query returns no results instead of faulting.
 */
const MAX_QUERY_LEN = 512

const BINARY_NAME = "mailwoman-nominatim"

function joinNonEmpty(...parts: Array<string | undefined>): string {
	return parts.filter((part) => part !== undefined && part.length).join(", ")
}

async function serve(engineStamp: ResolvedEngineStamp): Promise<void> {
	const { values } = parseArguments({
		options: {
			port: { type: "string", default: "8080" },
			host: { type: "string", default: "0.0.0.0" },
			"candidate-db": { type: "string" },
			// Permissive cors is on by default (browser geocoder clients need it).
			// `--no-cors` turns it off for deployments where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
		allowPositionals: true,
	})

	const port = Number(values.port) || 8080
	const host = values.host ?? "0.0.0.0"

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = await resolveGazetteerOrExit(values["candidate-db"])
	const { adminDBPath, candidateDB, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = await createResolverBackend(resolverMod, { wofPaths, candidateDB })
	const resolver = createWOFResolver(backend)
	const extracts = await USStateDatabaseProvider.create(resolverMod, dataRootPath())
	// National open-register rooftop tier: BAN-FR ahead of the OSM tier for a non-US parse.
	// A no-op when the extract is not on disk, so the endpoint degrades cleanly.
	const { BANRegionDatabaseProvider } = await import("@mailwoman/ban/sdk")
	const banExtracts = await BANRegionDatabaseProvider.create(dataRootPath())
	// The annotation fallback adds no country constraint to the geocode.
	// The default-on placer already routes the query's country.
	// `defaultCountry` is a hard override that beats it, so forcing "US" would
	// resolve every non-US query to its US namesake.
	// The fallback only annotates the flag, currency and calling code when the
	// resolved hierarchy omits the country tag.
	// US-centric data without a candidate DB omits it for US results, where "US" is
	// the right guess, while non-US results include the country tag.
	const annotationCountryFallback = candidateDB ? undefined : "US"
	const reverseGeo = adminDBPath ? new resolverMod.WOFReverseGeocoder({ adminDBPath }) : undefined
	const annotators = [coordinateFormatAnnotator, countryReferenceAnnotator]
	const tzDBPath = timezoneDatabasePath("timezone.db")

	if (await pathExists(tzDBPath)) {
		annotators.push(makeTimezoneAnnotator(new TimezoneLookup({ databasePath: resolvePath(tzDBPath) })))
	}

	const ulDBPath = dataRootPath("un-locode", "un-locode.db")

	if (await pathExists(ulDBPath)) {
		annotators.push(makeUNLocodeAnnotator(new UNLocodeLookup({ databasePath: resolvePath(ulDBPath) })))
	}

	const nutsDBPath = dataRootPath("nuts", "nuts.db")

	if (await pathExists(nutsDBPath)) {
		annotators.push(makeNUTSAnnotator(new NUTSLookup({ databasePath: resolvePath(nutsDBPath) })))
	}

	const annotate = composeAnnotators(annotators)

	// Read once at boot from the artifacts themselves, so this describes what the
	// endpoint serves from for as long as it serves.
	// Every artifact appears, including one carrying no manifest.
	const status = nominatimStatus(await gazetteerFreshness(gazetteer))

	const engine: NominatimEngine = {
		async search(params) {
			const query = (
				params.q ?? joinNonEmpty(params.street, params.city, params.state, params.postalcode, params.country)
			)?.trim()

			if (!query || query.length > MAX_QUERY_LEN) return []
			// A caller-supplied `countrycodes` is an explicit hard restriction in Nominatim semantics,
			// so it is honored as the country constraint even to the point of no result.
			// For a list we apply the first, the common geopy case.
			const userCountry = params.countrycodes?.[0]?.toUpperCase()

			const result = await geocodeAddress(query, {
				classifier,
				resolver,
				databases: extracts.for,
				nationalDatabases: banExtracts.for,
				defaultCountry: userCountry,
			})

			if (result.lat == null || result.lon == null) return []
			const resolved = forwardToResolved(result)

			// A house-grade resolution tier (`address_point`, `interpolated` or `plus_code`) is tagged
			// `class: place` and `type: house`, upstream Nominatim's own class and type for a house,
			// so a client that keys on those fields treats it as a building rather than an untyped admin hit.
			// The admin tier has no class here.
			if (
				result.resolution_tier === "address_point" ||
				result.resolution_tier === "interpolated" ||
				result.resolution_tier === "plus_code"
			) {
				resolved.category = "place"
				resolved.type = "house"
			}

			// The geocode result already includes the parse's street spans, so no second parse.
			if (result.house_number) {
				resolved.address.house_number = result.house_number
			}

			if (result.street) {
				resolved.address.road = result.street
			}

			// The country tag is not always in the hierarchy, since US admin results omit it.
			// Backfill from the US-centric-data default so the address, display name,
			// flag, currency and calling code agree.
			const countryName = result.hierarchy.find((h) => h.tag === "country")?.value ?? annotationCountryFallback
			const country = matchCountry(countryName)

			if (country) {
				if (!resolved.address.country && country.canonical) {
					resolved.address.country = country.canonical
				}

				resolved.address.country_code = country.iso2.toLowerCase()
			}

			if (result.house_number || result.street) {
				resolved.displayName =
					joinNonEmpty(
						result.house_number ?? undefined,
						result.street ?? undefined,
						resolved.address.city,
						resolved.address.state,
						resolved.address.postcode,
						resolved.address.country
					) || resolved.displayName
			}

			const out = toNominatimResult(resolved, { addressdetails: params.addressdetails })

			out.annotations = toOpenCage(
				await annotate({
					lat: result.lat,
					lon: result.lon,
					countryCode: country?.iso2,
					placeName: result.locality ?? undefined,
				})
			)

			return [out].slice(0, params.limit)
		},

		async reverse(params) {
			if (!reverseGeo) return null
			const { hierarchy } = await reverseGeo.reverseGeocode(params.lat, params.lon)

			if (!hierarchy.length) return null
			const address: NominatimAddressDetails = {}

			for (const place of hierarchy) {
				const key = PLACETYPE_TO_KEY[place.placetype]

				if (key && !address[key]) {
					address[key] = place.name
				}
			}

			const deepest = hierarchy[0]!

			if (deepest.country) {
				address.country_code = deepest.country.toLowerCase()
			}

			const resolved: ResolvedAddress = {
				lat: params.lat,
				lon: params.lon,
				address,
				displayName: hierarchy.map((p) => p.name).join(", "),
				placeID: deepest.id,
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
			return status
		},
	}

	const app = createNominatimApp(engine, { cors: values.cors, engine: engineStamp.stamp })

	await serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: () => {
			console.error(`[@mailwoman/nominatim] listening on http://${host}:${port}`)

			for (const line of gazetteerBannerLines(gazetteer)) {
				console.error(line)
			}

			// The terms come from the same `layer_manifest` rows the `/status` payload includes,
			// so the operator reads them at boot rather than by querying the endpoint they just started.
			for (const line of rightsBannerLines(status.mailwoman ?? { artifacts: [] })) {
				console.error(line)
			}

			console.error(corsBannerLine(values.cors))
			console.error(`  endpoints: GET /  GET /search  GET /reverse  GET /lookup  GET /status  GET /openapi.json`)
		},
	})
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi: openAPICommand(BINARY_NAME, createNominatimApp, NOMINATIM_DOC_INFO, {}),
	serve,
	usage: [
		"  serve [--port 8080] [--host 0.0.0.0] [--candidate-db <path>] [--no-cors]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
