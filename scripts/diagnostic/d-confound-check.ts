#!/usr/bin/env node
/**
 * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.
 *
 *   Verify-before-verdict for the #825 oracle-injection GO: is the PT/PL/AU original-parse coordinate
 *   error a PARSE failure (model extracts the wrong locality/postcode) or a RANKING/postcode-anchor
 *   confound (model parses it right, the resolver still lands on a same-name namesake)? Dump, per row:
 *   the gold locality+postcode, the model's RESOLVED locality+postcode+tier, and the error. If the
 *   model's parsed postcode/locality diverge from gold on the high-error rows → parse. If they match
 *   but it still resolves far → ranking. Run: node --expose-gc scripts/diagnostic/d-confound-check.ts
 */

import { existsSync, readFileSync } from "node:fs"

import { NeuralAddressClassifier } from "@mailwoman/neural"
import { createWofResolver } from "@mailwoman/resolver"
import { haversineKm } from "@mailwoman/spatial"
import { geocodeAddress, ShardProvider } from "mailwoman/geocode-core"
import { createResolverBackend, mailwomanDataRoot, wofShardPaths } from "mailwoman/resolver-backend"

const GOLDEN = process.argv[2] ?? "data/eval/external/oa-pt-coord-150.jsonl"
const N = Number(process.argv[3] ?? "12")

interface Row {
	raw: string
	components: { postcode?: string; locality?: string }
	country: string
	lat: number
	lon: number
}
const rows: Row[] = readFileSync(GOLDEN, "utf8")
	.trim()
	.split("\n")
	.slice(0, N)
	.map((l) => JSON.parse(l) as Row)

const resolverMod = await import("@mailwoman/resolver-wof-sqlite")
const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const resolver = createWofResolver(createResolverBackend(resolverMod, { wofPaths: wofShardPaths().filter(existsSync) }))
const shards = new ShardProvider(resolverMod, mailwomanDataRoot())

for (const r of rows) {
	const g = await geocodeAddress(r.raw, { classifier, resolver, shards: shards.for, defaultCountry: r.country })
	const err = g.lat != null && g.lon != null ? haversineKm(g.lat, g.lon, r.lat, r.lon).toFixed(0) : "∅"
	const pcMatch = (g.postcode ?? "").replace(/\s/g, "") === (r.components.postcode ?? "").replace(/\s/g, "")
	console.log(
		`err=${err.padStart(5)}km  pc[${pcMatch ? "=" : "≠"}] gold="${r.components.postcode}" got="${g.postcode}"  loc gold="${r.components.locality}" got="${g.locality}"  tier=${g.resolution_tier}\n   « ${r.raw} »`
	)
}
