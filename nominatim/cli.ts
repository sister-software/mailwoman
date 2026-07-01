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
 *   `WOFReverseGeocoder` (point-in-polygon over WOF admin polygons), reusing the same
 *   resolver-backend selector GeocodeRouter uses. Results carry the OpenCage-style `annotations`
 *   block — coordinate formats, flag, calling code, currency, and (when their DBs are present)
 *   timezone, UN/LOCODE, NUTS — composed from the `@mailwoman/*` annotators.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { composeAnnotators, toOpenCage } from "@mailwoman/annotations"
import { countryReferenceAnnotator, matchCountry } from "@mailwoman/codex/country"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { makeNutsAnnotator, NutsLookup } from "@mailwoman/nuts-lookup"
import { createWOFResolver, type ResolverBackend } from "@mailwoman/resolver"
import { coordinateFormatAnnotator } from "@mailwoman/spatial"
import { makeTimezoneAnnotator, TimezoneLookup } from "@mailwoman/timezone-lookup"
import { makeUnLocodeAnnotator, UnLocodeLookup } from "@mailwoman/un-locode-lookup"
import express from "express"
import { createAddressParser } from "mailwoman"
import { geocodeAddress, type GeocodeResult, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

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

/**
 * A real address fits comfortably; anything longer is malformed input (and would exceed the model's input window). Cap
 * defensively so a giant query returns no results instead of faulting.
 */
const MAX_QUERY_LEN = 512

function joinNonEmpty(...parts: Array<string | undefined>): string {
	return parts.filter(Boolean).join(", ")
}

/**
 * The resolver returns admin labels + a coordinate (often rooftop/interpolated via the situs shards) but drops the
 * street. Recover house_number + road from the parse so the result carries the full address — Nominatim populates both
 * `addressdetails` and `display_name` down to the house number.
 */
async function streetParts(
	parser: ReturnType<typeof createAddressParser>,
	query: string
): Promise<{ houseNumber?: string; road?: string }> {
	const solution = (await parser.parse(query, { verbose: true })).solutions[0]
	const matches = (solution?.toJSON() as { matches?: Array<{ classification: string; value: string }> })?.matches ?? []

	return {
		houseNumber: matches.find((m) => m.classification === "house_number")?.value,
		road: matches.find((m) => m.classification === "street")?.value,
	}
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
			"candidate-db": { type: "string" },
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 8080
	const host = values.host ?? "0.0.0.0"

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const wofPaths = wofShardPaths().filter(existsSync)
	const adminDBPath = wofPaths[0]

	// Candidate gazetteer = worldwide resolution (population-first ranking + global coverage + the
	// FTS5-trigram typo fallback). Resolve it from --candidate-db / $MAILWOMAN_CANDIDATE_DB, else auto-use
	// one already fetched to the data root (`mailwoman fetch-gazetteer` writes `<data-root>/wof/candidate.db`).
	// Absent → admin-only (US-optimized) — the no-download default.
	const conventionCandidate = join(mailwomanDataRoot(), "wof", "candidate.db")
	const candidateDb =
		resolveCandidateDBPath(values["candidate-db"]) ??
		(existsSync(conventionCandidate) ? conventionCandidate : undefined)

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const parser = createAddressParser()
	const backend = createResolverBackend(resolverMod, { wofPaths, candidateDb })
	const resolver = createWOFResolver(backend as unknown as ResolverBackend)
	const shards = new ShardProvider(resolverMod, mailwomanDataRoot())
	// NOT a geocode country constraint. The default-on #244 placer already routes the query's country
	// (Berlin→DE, Boston→US) and `defaultCountry` is a HARD override that beats it (geocode-core.ts:102),
	// so forcing "US" resolved every non-US query to its US namesake (Berlin→Berlin NH). We let the
	// placer decide instead. This is the fallback used ONLY to annotate the flag/currency/calling-code
	// when the resolved hierarchy omits the country tag — which on US-centric data (no candidate DB)
	// happens for US results, where "US" is the right guess. Non-US results carry the country tag, so
	// the fallback never mislabels them.
	const annotationCountryFallback = candidateDb ? undefined : "US"
	const reverseGeo = adminDBPath ? new resolverMod.WOFReverseGeocoder({ adminDBPath }) : undefined
	const annotators = [coordinateFormatAnnotator, countryReferenceAnnotator]
	const tzDBPath = join(mailwomanDataRoot(), "timezone", "timezone.db")

	if (existsSync(tzDBPath)) annotators.push(makeTimezoneAnnotator(new TimezoneLookup({ databasePath: tzDBPath })))
	const ulDBPath = join(mailwomanDataRoot(), "un-locode", "un-locode.db")

	if (existsSync(ulDBPath)) annotators.push(makeUnLocodeAnnotator(new UnLocodeLookup({ databasePath: ulDBPath })))
	const nutsDBPath = join(mailwomanDataRoot(), "nuts", "nuts.db")

	if (existsSync(nutsDBPath)) annotators.push(makeNutsAnnotator(new NutsLookup({ databasePath: nutsDBPath })))
	const annotate = composeAnnotators(annotators)

	const engine: NominatimEngine = {
		async search(params) {
			const query = (
				params.q ?? joinNonEmpty(params.street, params.city, params.state, params.postalcode, params.country)
			)?.trim()

			// Empty/whitespace → no query; absurdly long → not an address (and would blow the model's input).
			if (!query || query.length > MAX_QUERY_LEN) return []
			// A caller-supplied `countrycodes` is an explicit hard restriction (Nominatim semantics): honor
			// it as the country constraint, even to the point of no result. It doubles as the manual override
			// for the #822 placer frontier — `countrycodes=au` lands Sydney in Australia. One country is the
			// common (geopy) case; for a list we apply the first.
			const userCountry = params.countrycodes?.[0]?.toUpperCase()
			const result = await geocodeAddress(query, {
				classifier,
				resolver,
				shards: shards.for,
				defaultCountry: userCountry,
			})

			if (result.lat == null || result.lon == null) return []
			const resolved = forwardToResolved(result)
			// Recover the street the resolver drops, so addressdetails + display_name carry it.
			const { houseNumber, road } = await streetParts(parser, query)

			if (houseNumber) resolved.address.house_number = houseNumber

			if (road) resolved.address.road = road
			// The country tag isn't always in the hierarchy (US admin results omit it); backfill from the
			// US-centric-data default so the address, display_name, and flag/currency/calling-code agree.
			const countryName = result.hierarchy.find((h) => h.tag === "country")?.value ?? annotationCountryFallback
			const country = matchCountry(countryName)

			if (country) {
				if (!resolved.address.country) resolved.address.country = country.canonical
				resolved.address.country_code = country.iso2.toLowerCase()
			}

			if (houseNumber || road) {
				resolved.displayName =
					joinNonEmpty(
						houseNumber,
						road,
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
			return { status: 0, message: "OK" }
		},
	}

	express()
		.use(createNominatimRouter(engine))
		.listen(port, host, () => {
			console.error(`[@mailwoman/nominatim] listening on http://${host}:${port}`)
			console.error(`  wof: ${adminDBPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`)
			console.error(
				candidateDb
					? `  resolver: candidate gazetteer (worldwide) — ${candidateDb}`
					: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`
			)
			console.error(`  endpoints: GET /search  GET /reverse  GET /lookup  GET /status`)
		})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		await serve()
		break
	default:
		console.error("Usage: mailwoman-nominatim serve [--port 8080] [--host 0.0.0.0] [--candidate-db <path>]")
		process.exit(command ? 1 : 0)
}
