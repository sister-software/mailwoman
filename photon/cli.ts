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

import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { matchCountry } from "@mailwoman/codex/country"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWOFResolver } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDBPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

import {
	createPhotonRouter,
	photonCollection,
	photonFeature,
	photonForwardCollection,
	type PhotonForwardInput,
	photonOSMTags,
	type PhotonEngine,
	type PhotonProperties,
} from "./index.js"

/** WOF placetype → Photon property key. */
const PLACETYPE_TO_KEY: Record<string, keyof PhotonProperties> = {
	street: "street",
	locality: "city",
	localadmin: "city",
	county: "county",
	region: "state",
	country: "country",
}

/** A real address fits comfortably; longer is malformed input (and would exceed the model's window). */
const MAX_QUERY_LEN = 512

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
	const wofPaths = wofShardPaths().filter(existsSync)
	const adminDBPath = wofPaths[0]

	// Candidate gazetteer = worldwide resolution (see @mailwoman/nominatim). --candidate-db /
	// $MAILWOMAN_CANDIDATE_DB, else auto-use one fetched to `<data-root>/wof/candidate.db`; absent → admin-only.
	const conventionCandidate = join(mailwomanDataRoot(), "wof", "candidate.db")
	const candidateDb =
		resolveCandidateDBPath(values["candidate-db"]) ??
		(existsSync(conventionCandidate) ? conventionCandidate : undefined)

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
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
			const primary: PhotonForwardInput = {
				lat: result.lat,
				lon: result.lon,
				postcode: result.postcode,
				country: country ? { name: country.canonical, code: country.iso2 } : undefined,
				places: result.hierarchy.map((h) => ({ tag: h.tag, name: h.name })),
				...(houseGrade ? { house: { number: result.house_number, street: result.street } } : {}),
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

			if (hierarchy.length === 0) return photonCollection([])
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

	const express = (await import("express")).default
	express()
		.use(createPhotonRouter(engine, { cors: values.cors }))
		.listen(port, host, () => {
			console.error(`[@mailwoman/photon] listening on http://${host}:${port}`)
			console.error(`  wof: ${adminDBPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`)
			console.error(
				candidateDb
					? `  resolver: candidate gazetteer (worldwide) — ${candidateDb}`
					: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`
			)
			console.error(`  cors: ${values.cors ? "enabled (Access-Control-Allow-Origin: *)" : "disabled (--no-cors)"}`)
			console.error(`  endpoints: GET /api  GET /reverse`)
		})
}

// Subcommand dispatch via parseArgs (strict:false — the per-command parsers own their flags).
const command = parseArgs({ strict: false, allowPositionals: true }).positionals[0]

switch (command) {
	case "serve":
		await serve()
		break
	default:
		console.error("Usage: mailwoman-photon serve [--port 2322] [--host 0.0.0.0] [--candidate-db <path>] [--no-cors]")
		process.exit(command ? 1 : 0)
}
