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
 *   `WofReverseGeocoder`, projecting results into Photon's GeoJSON FeatureCollection. The FST
 *   autocomplete tier is the eventual front for `/api`; geocode resolution is the MVP path.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { parseArgs } from "node:util"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import {
	createResolverBackend,
	mailwomanDataRoot,
	resolveCandidateDbPath,
	wofShardPaths,
} from "mailwoman/resolver-backend"

import {
	createPhotonRouter,
	photonCollection,
	photonFeature,
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
		},
		allowPositionals: true,
	})

	const port = Number(values.port) || 2322
	const host = values.host ?? "0.0.0.0"

	const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
	const wofPaths = wofShardPaths().filter(existsSync)
	const adminDbPath = wofPaths[0]

	// Candidate gazetteer = worldwide resolution (see @mailwoman/nominatim). --candidate-db /
	// $MAILWOMAN_CANDIDATE_DB, else auto-use one fetched to `<data-root>/wof/candidate.db`; absent → admin-only.
	const conventionCandidate = join(mailwomanDataRoot(), "wof", "candidate.db")
	const candidateDb =
		resolveCandidateDbPath(values["candidate-db"]) ??
		(existsSync(conventionCandidate) ? conventionCandidate : undefined)

	const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
	const backend = createResolverBackend(resolverMod, { wofPaths, candidateDb })
	const resolver = createWofResolver(backend as unknown as ResolverBackend)
	const shards = new ShardProvider(resolverMod, mailwomanDataRoot())
	const reverseGeo = adminDbPath ? new resolverMod.WofReverseGeocoder({ adminDbPath }) : undefined

	const engine: PhotonEngine = {
		async search(params) {
			// Empty/whitespace → no query; absurdly long → not an address (and would blow the model's input).
			const query = params.q?.trim()

			if (!query || query.length > MAX_QUERY_LEN) return photonCollection([])
			// No country constraint: the default-on #244 placer routes the query's country (Berlin→DE,
			// Boston→US). Forcing "US" here is a HARD override (geocode-core.ts:102) that resolved every
			// non-US query to its US namesake — wrong for a global autocomplete front.
			const result = await geocodeAddress(query, { classifier, resolver, shards: shards.for })

			if (result.lat == null || result.lon == null) return photonCollection([])
			const properties: PhotonProperties = {
				name: result.locality ?? result.region ?? undefined,
				city: result.locality ?? undefined,
				state: result.region ?? undefined,
				postcode: result.postcode ?? undefined,
			}

			for (const h of result.hierarchy) if (h.tag === "country") properties.country = h.value

			return photonCollection([photonFeature(result.lon, result.lat, properties)])
		},

		async reverse(params) {
			if (!reverseGeo) return photonCollection([])
			const { hierarchy } = await reverseGeo.reverseGeocode(params.lat, params.lon)

			if (hierarchy.length === 0) return photonCollection([])
			const deepest = hierarchy[0]!
			const properties: PhotonProperties = { name: deepest.name, countrycode: deepest.country?.toLowerCase() }

			for (const place of hierarchy) {
				const key = PLACETYPE_TO_KEY[place.placetype]

				if (key && properties[key] == null) properties[key] = place.name
			}

			return photonCollection([photonFeature(deepest.lon, deepest.lat, properties)])
		},
	}

	const express = (await import("express")).default
	express()
		.use(createPhotonRouter(engine))
		.listen(port, host, () => {
			console.error(`[@mailwoman/photon] listening on http://${host}:${port}`)
			console.error(`  wof: ${adminDbPath ?? "(none found — set MAILWOMAN_WOF_DB)"}`)
			console.error(
				candidateDb
					? `  resolver: candidate gazetteer (worldwide) — ${candidateDb}`
					: `  resolver: admin-only (US-optimized) — point --candidate-db / $MAILWOMAN_CANDIDATE_DB at a candidate gazetteer for worldwide`
			)
			console.error(`  endpoints: GET /api  GET /reverse`)
		})
}

const command = process.argv[2]

switch (command) {
	case "serve":
		await serve()
		break
	default:
		console.error("Usage: mailwoman-photon serve [--port 2322] [--host 0.0.0.0] [--candidate-db <path>]")
		process.exit(command ? 1 : 0)
}
