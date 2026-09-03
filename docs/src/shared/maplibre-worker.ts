/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Points MapLibre at its staged tile worker. Import for the side effect before any `<Map>` mounts.
 */

import { setWorkerUrl } from "maplibre-gl"

import { MAPLIBRE_WORKER_URL } from "./maplibre-worker-url.ts"

// MapLibre's default worker URL comes from `import.meta.url`, which the classic-script client bundle inlines as a
// build-host `file:` path; MapLibre answers "" for that and spawns the page itself as the worker. The tell is a map
// that composes its style and never requests a tile. See `stageMapLibreWorker` in the demo-assets plugin.
setWorkerUrl(MAPLIBRE_WORKER_URL)
