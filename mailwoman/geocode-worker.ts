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
import { createWofResolver, type ResolverBackend } from "@mailwoman/resolver"

import { geocodeAddress, ShardProvider } from "./geocode-core.js"
import type { GeocodeStreamConfig } from "./geocode-stream.js"

const { mapping, geocode: cfg } = (workerData?.userData ?? {}) as {
	mapping: ColumnMapping
	geocode: GeocodeStreamConfig
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: cfg.locale })
const wof = await import("@mailwoman/resolver-wof-sqlite")
const lookup = new wof.WofSqlitePlaceLookup({ databasePath: cfg.wofDbPath })
const resolver = createWofResolver(lookup as unknown as ResolverBackend)
const shards = new ShardProvider(wof, cfg.dataRoot)

const seam = geocodeAddressVia({
	parse: async (raw) => decodeAsJSON(await classifier.parse(raw, { postcodeRepair: true })),
	geocode: (raw) =>
		geocodeAddress(raw, {
			classifier,
			resolver,
			shards: shards.for,
			defaultCountry: cfg.country ?? "US",
			placeCountry: false,
		}),
	country: cfg.country,
})

export const handleItem = makeGeocodeHandler(seam, mapping)
