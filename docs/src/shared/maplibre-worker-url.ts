/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The same-origin URL of MapLibre's staged tile worker.
 */

/**
 * Where the demo-assets plugin stages `maplibre-gl-worker.mjs` (plus the module it imports) under `static/`. Pure so
 * the plugin's unit test can import it without pulling `maplibre-gl` into Node.
 */
export const MAPLIBRE_WORKER_URL = "/mailwoman/maplibre/maplibre-gl-worker.mjs"
