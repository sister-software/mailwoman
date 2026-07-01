/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Runs inside a worker thread (spawned by `geocodeStream` via `spliterator.parallelMap`). Top-level
 * code is per-worker init: rebuild the classifier, WOF SQLite lookup, resolver, and geometry shards
 * from the serializable `workerData.userData` config (paths + locale), then assemble the same geocode
 * seam the CLI builds. Each dispatched record is geocoded by `makeGeocodeHandler`.
 */

import { workerData } from "node:worker_threads"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { type ColumnMapping, geocodeAddressVia, makeGeocodeHandler } from "@mailwoman/registry"
import { createWOFResolver, type ResolverBackend } from "@mailwoman/resolver"

import { geocodeAddress, parseForGeocode, ShardProvider } from "./geocode-core.js"
import type { GeocodeStreamConfig } from "./geocode-stream.js"

const { mapping, geocode: cfg } = (workerData?.userData ?? {}) as {
	mapping: ColumnMapping
	geocode: GeocodeStreamConfig
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: cfg.locale })
const wof = await import("@mailwoman/resolver-wof-sqlite")
const lookup = new wof.WOFSqlitePlaceLookup({ databasePath: cfg.wofDBPath })
const resolver = createWOFResolver(lookup as unknown as ResolverBackend)
const shards = new ShardProvider(wof, cfg.dataRoot)

const geoDeps = {
	classifier,
	resolver,
	shards: shards.for,
	defaultCountry: cfg.country ?? "US",
	placeCountry: false,
} as const

// Parse ONCE per address (the ~3 ms/row inference is the dominant cost): share the tree between the PostalAddress
// (decodeAsJSON) and the geocode (parsedTree). Coordinates are byte-identical to the two-parse path — geocodeAddress
// would have produced this exact tree internally; only the PostalAddress now reflects the normalized parse.
const seam = geocodeAddressVia({
	parseAndGeocode: async (raw) => {
		const tree = await parseForGeocode(raw, geoDeps)
		const geo = await geocodeAddress(raw, { ...geoDeps, parsedTree: tree })

		return { components: decodeAsJSON(tree), geo }
	},
	country: cfg.country,
})

export const handleItem = makeGeocodeHandler(seam, mapping)
