/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The injected-geocoder interface for the record-matcher tools. The registry package never imports
 *   the heavy runtime (neural parser, WOF resolver, per-state extracts), since `mailwoman` depends on
 *   `@mailwoman/registry` and the reverse import would cycle the workspace graph. Each tool instead
 *   takes an {@linkcode EvalGeocoderFactory} the CLI command constructs from
 *   `mailwoman/geocode-core` (see `mailwoman/commands/registry/run.tsx`).
 */

import type { ColumnMapping, GeocodeAddress, SourceRecord } from "#index"

/**
 * The raw single-address geocode surface used by the probe tools, mirroring
 * `mailwoman/geocode-core`'s wire shape.
 */
export interface EvalGeocodeResult {
	lat: number | null
	lon: number | null
	/**
	 * Wire key that mirrors `GeocodeResult.resolution_tier`.
	 */
	resolution_tier?: string | null
}

/**
 * A constructed geocoder: the matcher's ingest interface, the raw geocode and the handle release.
 */
export interface EvalGeocoder extends Disposable {
	/**
	 * The matcher's ingest interface (parse and geocode to `PostalAddress`),
	 * built through `geocodeAddressVia`.
	 */
	geocodeAddress: GeocodeAddress
	/**
	 * Raw single-address geocode returning lat, lon and resolution tier.
	 */
	geocode: (address: string) => Promise<EvalGeocodeResult>
	/**
	 * Release the DB handles (extracts + WOF lookup).
	 */
}

/**
 * Per-construction toggles a tool may need to control (the command owns model/WOF/data-root wiring).
 */
export interface EvalGeocoderInit {
	/**
	 * All-caps case normalization.
	 *
	 * Default on.
	 * `nppes-benchmark --legacy-join` turns it off for the A/B.
	 */
	normalizeCase?: boolean
}

/**
 * Build a geocoder on demand.
 *
 * Tools construct it late and dispose it as soon as geocoding is done.
 */
export type EvalGeocoderFactory = (init?: EvalGeocoderInit) => Promise<EvalGeocoder>

/**
 * The threaded geocode surface (`mailwoman/geocode-stream` behind the interface)
 * for `nppes-dedup-benchmark --parallel-geocode`.
 * It yields enriched records in completion order.
 */
export type EvalGeocodeStream = (
	records: SourceRecord[],
	opts: { mapping: ColumnMapping; concurrency: number }
) => AsyncIterable<SourceRecord>
