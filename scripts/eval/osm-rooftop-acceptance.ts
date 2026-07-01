/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #247 acceptance: geocode FR addresses end-to-end through the drop-in (`geocodeAddress`) with the OSM
 *   rooftop tier wired (`osmShards`), and check the resolved coordinate + tier. The headline case is the
 *   demo's `181 Rue du Chevaleret, Paris` — admin-only resolves to the arrondissement centroid; with the
 *   OSM tier it should resolve `address_point` to the building. Runs with an explicit defaultCountry AND
 *   via the coarse placer (no country hint) to confirm the placer routes a bare "…Paris" to the FR shard.
 *
 *   Run: node scripts/eval/osm-rooftop-acceptance.ts
 */

import { existsSync } from "node:fs"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { OSMShardProvider } from "@mailwoman/osm/sdk"
import { createWOFResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const resolver = createWOFResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())
const osm = new OSMShardProvider(mailwomanDataRoot())

interface Case {
	q: string
	country?: string
	expect: [number, number]
}

const PANEL: Case[] = [
	{ q: "181 Rue du Chevaleret, Paris", country: "FR", expect: [48.8335023, 2.3686051] },
	{ q: "181 Rue du Chevaleret, 75013 Paris", country: "FR", expect: [48.8335023, 2.3686051] },
	// no defaultCountry — the coarse placer must route "…Paris" to FR and pick the OSM shard:
	{ q: "181 Rue du Chevaleret, Paris", country: undefined, expect: [48.8335023, 2.3686051] },
]

for (const t of PANEL) {
	const g = await geocodeAddress(t.q, {
		classifier,
		resolver,
		shards: shards.for,
		osmShards: osm.for,
		defaultCountry: t.country,
	})
	const errKm = g.lat != null && g.lon != null ? haversineKm(g.lat, g.lon, t.expect[0], t.expect[1]) : null
	const verdict = g.resolution_tier === "address_point" && (errKm ?? 99) < 0.1 ? "✅ ROOFTOP" : "—"

	console.log(`\n${t.q}   [country=${t.country ?? "placer"}]`)
	console.log(
		`   tier=${g.resolution_tier}  lat=${g.lat}  lon=${g.lon}  err=${errKm?.toFixed(3) ?? "n/a"} km  ${verdict}`
	)
}

shards.close()
osm.close()
