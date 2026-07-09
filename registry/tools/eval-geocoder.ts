/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The injected-geocoder contract for the record-matcher tools. The registry package deliberately
 *   never imports the heavy runtime (neural parser, WOF resolver, per-state shards) — `mailwoman`
 *   depends on `@mailwoman/registry`, so the reverse import would cycle the workspace graph. Instead
 *   each tool takes an {@linkcode EvalGeocoderFactory} the CLI command constructs from
 *   `mailwoman/geocode-core` (see `mailwoman/commands/registry/run.tsx`), mirroring the matcher's own
 *   `GeocodeAddress` seam philosophy: ingest never pins the runtime, the caller wires it.
 */

import type { ColumnMapping, GeocodeAddress, SourceRecord } from "@mailwoman/registry"

/** The raw single-address geocode surface (the probe tools) — mirrors `mailwoman/geocode-core`'s wire shape. */
export interface EvalGeocodeResult {
	lat: number | null
	lon: number | null
	/** Wire key — mirrors `GeocodeResult.resolution_tier`. */
	resolution_tier?: string | null
}

/** A constructed geocoder: the matcher's ingest seam, the raw geocode, and the handle release. */
export interface EvalGeocoder {
	/** The matcher's ingest seam (parse + geocode → `PostalAddress`), built via `geocodeAddressVia`. */
	seam: GeocodeAddress
	/** Raw single-address geocode — lat/lon + resolution tier. */
	geocode: (address: string) => Promise<EvalGeocodeResult>
	/** Release the DB handles (shards + WOF lookup). */
	close: () => void
}

/** Per-construction toggles a tool may need to control (the command owns model/WOF/data-root wiring). */
export interface EvalGeocoderInit {
	/** #690 all-caps case normalization. Default on; `nppes-benchmark --legacy-join` turns it off for the A/B. */
	normalizeCase?: boolean
}

/** Build a geocoder on demand — tools construct late and `close()` as soon as geocoding is done. */
export type EvalGeocoderFactory = (init?: EvalGeocoderInit) => Promise<EvalGeocoder>

/**
 * The threaded geocode surface (`mailwoman/geocode-stream` behind the seam) for `nppes-dedup-benchmark
 * --parallel-geocode`. Yields enriched records in completion order.
 */
export type EvalGeocodeStream = (
	records: SourceRecord[],
	opts: { mapping: ColumnMapping; concurrency: number }
) => AsyncIterable<SourceRecord>
