#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mailwoman-photon` — boot a Photon-compatible autocomplete endpoint via the `serve` command.
 *   Usage
 *
 *   - Examples live in the package README.
 *
 *   Wires the real engine: `/api` over `geocodeAddress` (parse → resolve), `/reverse` over
 *   `WOFReverseGeocoder`, projecting results into Photon's GeoJSON FeatureCollection. The FST
 *   autocomplete tier is the eventual front for `/api`; geocode resolution is the MVP path.
 */

import { parseArgs } from "node:util"

import { printOpenAPIDocument, serveNode } from "@mailwoman/api-kit"
import { matchCountry } from "@mailwoman/codex/country"
import { createWOFResolver } from "@mailwoman/resolver"
import {
	corsBannerLine,
	gazetteerBannerLines,
	loadClassifierOrExit,
	parseOpenAPIFlags,
	resolveGazetteerOrExit,
	runDropInCLI,
} from "mailwoman/cli-kit/dropin"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot } from "mailwoman/resolver-backend"

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
} from "./index.ts"

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
 * A real address fits comfortably; longer is malformed input (and would exceed the model's window).
 */
const MAX_QUERY_LEN = 512

const BINARY_NAME = "mailwoman-photon"

async function serve(): Promise<void> {
	const { values } = parseArgs({
		options: {
			port: { type: "string", default: "2322" },
			host: { type: "string", default: "0.0.0.0" },
			"candidate-db": { type: "string" },
			// Permissive CORS is on by default (upstream Photon parity — browser widgets need it). `--no-cors`
			// turns it off for deployments where a reverse proxy already sets the headers.
			cors: { type: "boolean", default: true },
		},
		allowNegative: true,
		allowPositionals: true,
	})

	const port = Number(values.port) || 2322
	const host = values.host ?? "0.0.0.0"

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const gazetteer = resolveGazetteerOrExit(values["candidate-db"])
	const { adminDBPath, candidateDb, wofPaths } = gazetteer
	const classifier = await loadClassifierOrExit()

	const backend = createResolverBackend(resolverMod, { wofPaths, candidateDb })
	const resolver = createWOFResolver(backend)
	const shards = new ShardProvider(resolverMod, mailwomanDataRoot())
	// National open-register rooftop tier (#1012): BAN-FR ahead of the OSM tier for a non-US parse. A no-op
	// when the shard isn't on disk (existsSync-gated inside the provider), so the endpoint degrades cleanly.
	const { BANShardProvider } = await import("@mailwoman/ban/sdk")
	const banShards = new BANShardProvider(mailwomanDataRoot())
	const reverseGeo = adminDBPath ? new resolverMod.WOFReverseGeocoder({ adminDBPath }) : undefined

	const engine: PhotonEngine = {
		async search(params) {
			// Empty/whitespace → no query; absurdly long → not an address (and would blow the model's input).
			const query = params.q?.trim()

			if (!query || query.length > MAX_QUERY_LEN) return photonCollection([])
			// #1016: forward the client's viewport/user location as a proximity bias — a SOFT re-rank the resolver
			// folds into candidate scoring (Springfield near the map center wins). Only when both coords are present.
			const bias = params.lat != null && params.lon != null ? [{ lat: params.lat, lon: params.lon }] : undefined

			// No country constraint: the default-on #244 placer routes the query's country (Berlin→DE,
			// Boston→US). Forcing "US" here is a HARD override (geocode-core.ts:102) that resolved every
			// non-US query to its US namesake — wrong for a global autocomplete front.
			const result = await geocodeAddress(query, {
				classifier,
				resolver,
				shards: shards.for,
				nationalShards: banShards.for,
				bias,
				// Decision A endpoint default: Photon is an autocomplete front — a human typing fragments.
				inputMode: "fragmented",
			})

			if (result.lat == null || result.lon == null) return photonCollection([])
			// #1014: decorate from the RESOLVED gazetteer place — proper-cased ancestry names (`hierarchy[].name`,
			// not the parsed span) + the resolved country (ISO2 → canonical name via codex) + osm_key/value/type so
			// Photon clients don't TypeError. The candidate backend fills only the locality (no ancestors() table),
			// so state/county come through only on an ancestry-capable backend — country still lands from the code.
			const country = matchCountry(result.countryCode)
			// #1041: a rooftop (`address_point`) or house-number-estimate (`interpolated`) tier is HOUSE-GRADE — carry the
			// parsed housenumber + street so photonForwardProperties decorates it `type: house` (matching upstream Photon)
			// instead of inheriting the admin locality's `type: city`. The admin tier (a locality centroid) never does.
			const houseGrade = result.resolution_tier === "address_point" || result.resolution_tier === "interpolated"
			// #1050: the street-centroid tier is STREET-GRADE — full assembled street name in `name`,
			// highway/street osm tags (the parallel of the #1041 house treatment).
			const streetGrade = result.resolution_tier === "street"

			const primary: PhotonForwardInput = {
				lat: result.lat,
				lon: result.lon,
				postcode: result.postcode,
				country: country ? { name: country.canonical, code: country.iso2 } : undefined,
				places: result.hierarchy.map((h) => ({ tag: h.tag, name: h.name })),
				...(houseGrade ? { house: { number: result.house_number, street: result.street } } : {}),
				...(streetGrade ? { street: { name: result.street } } : {}),
			}

			// #1016: candidates[0] is the primary itself; its ranked alternatives (Springfield MA/IL/…) become the
			// extra features, up to the requested `limit`. Each alternative is a single resolved place.
			const alternatives = result.candidates.slice(1).map((c) => {
				const cc = matchCountry(c.countryCode)

				return {
					lat: c.lat,
					lon: c.lon,
					country: cc ? { name: cc.canonical, code: cc.iso2 } : undefined,
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

			// #1014: carry osm_key/osm_value/type (from the deepest placetype) so /reverse matches /api's schema —
			// no Photon client should dereference an undefined osm_key on a reverse result either.
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

	const app = createPhotonApp(engine, { cors: values.cors })

	serveNode({
		fetch: app.fetch,
		port,
		hostname: host,
		onListen: () => {
			console.error(`[@mailwoman/photon] listening on http://${host}:${port}`)

			for (const line of gazetteerBannerLines(gazetteer)) {
				console.error(line)
			}

			console.error(corsBannerLine(values.cors))
			console.error(`  endpoints: GET /  GET /api  GET /reverse  GET /openapi.json`)
		},
	})
}

/**
 * `openapi` — print (or `--out`-write) the emitted OpenAPI document for this surface. Builds the app around an
 * all-optional stub {@link PhotonEngine} (`{}` — every route answers 501 under this stub, but the document itself only
 * reflects the ROUTE TABLE, not handler behavior) so this NEVER boots the neural classifier or opens a gazetteer DB:
 * pure route-table introspection, fast regardless of data-root state. `--flavor 3.0` prints the 3.0.3 diet instead of
 * the default 3.1.0.
 */
function openapi(): void {
	const app = createPhotonApp({})

	printOpenAPIDocument(app, PHOTON_DOC_INFO, parseOpenAPIFlags(BINARY_NAME))
}

await runDropInCLI({
	binaryName: BINARY_NAME,
	openapi,
	serve,
	usage: [
		"  serve [--port 2322] [--host 0.0.0.0] [--candidate-db <path>] [--no-cors]",
		"  openapi [--flavor 3.1|3.0] [--out <path>]",
	],
})
