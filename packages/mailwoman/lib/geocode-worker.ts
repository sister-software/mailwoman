/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Runs inside a worker thread (spawned by `geocodeStream` via `spliterator.parallelMap`). Top-level
 * code is per-worker init: rebuild the classifier, WOF SQLite lookup, resolver, and geometry databases
 * from the serializable `workerData.userData` config (paths + locale), then assemble the same geocode
 * seam the CLI builds. Each dispatched record is geocoded by `makeGeocodeHandler`.
 */

import { workerData } from "node:worker_threads"

import { decodeAsJSON } from "@mailwoman/core/decoder"
import { NeuralAddressClassifier } from "@mailwoman/neural"
import { type ColumnMapping, geocodeAddressVia, makeGeocodeHandler } from "@mailwoman/registry"
import { createWOFResolver } from "@mailwoman/resolver"

import { geocodeAddress, parseForGeocode } from "#geocode-core"
import { RegionDatabaseProvider } from "#geocode-regions"
import type { GeocodeStreamConfig } from "#geocode-stream"
import { createResolverBackend } from "#resolver-backend"

const { mapping, geocode: cfg } = (workerData?.userData ?? {}) as {
	mapping: ColumnMapping
	geocode: GeocodeStreamConfig
}

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: cfg.locale })
const wof = await import("@mailwoman/resolver-wof-sqlite")
// Through the selector, not a direct FTS construction: a batch worker must resolve the same way the CLI and the
// drop-in servers do, or a row geocoded in bulk answers differently from the same row geocoded singly.
const lookup = await createResolverBackend(wof, { dataRoot: cfg.dataRoot, wofPaths: cfg.wofDBPath })
const resolver = createWOFResolver(lookup)
const databases = await RegionDatabaseProvider.create(wof, cfg.dataRoot)

const geoDeps = {
	classifier,
	resolver,
	databases: databases.for,
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

/**
 * Per-item handler the worker pool invokes. Bound to this worker's seam and mapping at module load, so each item costs
 * only the geocode itself.
 */
export const handleItem = makeGeocodeHandler(seam, mapping)
