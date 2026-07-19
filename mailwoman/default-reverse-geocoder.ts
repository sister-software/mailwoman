/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The default read-time WOF reverse geocoder for POI ancestry — the poiQueryKind register row's second
 *   debt payment (runtime-flags.mdx): `createRuntimePipeline({ poiQueryKind: { poiDatabasePath } })`
 *   lazily loads this once per process and wires a SYNCHRONOUS adapter into `createPOIExecutor`'s
 *   `reverseGeocode` dep (the executor's return type carries no `Promise` — see `poi-intent.ts`'s
 *   `deps.execute`, called synchronously). `WOFReverseGeocoder.reverseGeocodeSync` (added alongside this
 *   feature) is the real synchronous core the async `reverseGeocode` already wrapped — see
 *   resolver-wof-sqlite/reverse.ts.
 *
 *   `@mailwoman/resolver-wof-sqlite` is an optional peer dep and the admin gazetteer (with its
 *   `place_bbox` R*Tree, `mailwoman gazetteer build fts`) is a multi-GB build artifact that may not be on
 *   disk — either gap yields `null` and POI results simply carry no `ancestry` key at all (house
 *   meaning-of-zero: absence, never an empty array). The polygon sidecar (`wof-polygons.db`) is OPTIONAL
 *   too; without it every ancestry chain still resolves, just `containment: "approximate"`
 *   (`WOFReverseGeocoder`'s own centroid-descent fallback).
 *
 *   Admin DB resolution mirrors `resolver-backend.ts`'s `wofShardPaths()` — the SAME default
 *   `@mailwoman/photon`'s and `@mailwoman/nominatim`'s `serve` commands use for their own
 *   `WOFReverseGeocoder` (`photon/cli.ts`, `nominatim/cli.ts`): first existing shard in the list wins
 *   (`admin-global-priority.db` first). The polygon sidecar is read from `$MAILWOMAN_WOF_POLYGONS_DB` —
 *   the same env var `mailwoman reverse` reads (`commands/reverse.tsx`).
 */

import { existsSync } from "node:fs"

import { $public } from "@mailwoman/core/env"
import type { WOFReverseGeocoder as WOFReverseGeocoderType } from "@mailwoman/resolver-wof-sqlite"

import { wofShardPaths } from "./resolver-backend.ts"

let cached: Promise<WOFReverseGeocoderType | null> | null = null

/**
 * Lazy-load + cache the default `WOFReverseGeocoder`. `null` when no admin shard with a `place_bbox` R*Tree is on disk,
 * or `@mailwoman/resolver-wof-sqlite` can't be resolved (stripped install) — the pipeline then wires no
 * `reverseGeocode` fn at all, so POI results degrade to no `ancestry` (byte-stable pre-feature behavior). Cached for
 * the process lifetime (one handle, reused).
 */
export function loadDefaultReverseGeocoder(): Promise<WOFReverseGeocoderType | null> {
	if (!cached) {
		cached = (async (): Promise<WOFReverseGeocoderType | null> => {
			try {
				const adminDBPath = wofShardPaths().filter(existsSync)[0]

				if (!adminDBPath) return null
				const { WOFReverseGeocoder } = await import("@mailwoman/resolver-wof-sqlite")
				const polygonDBPath = $public.MAILWOMAN_WOF_POLYGONS_DB

				return new WOFReverseGeocoder({
					adminDBPath,
					...(polygonDBPath && existsSync(polygonDBPath) ? { polygonDBPath } : {}),
				})
			} catch {
				return null
			}
		})()
	}

	return cached
}
