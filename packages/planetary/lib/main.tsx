/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { setWorkerUrl } from "maplibre-gl"
import maplibreWorkerURL from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

import { App } from "./App.tsx"

// MapLibre derives its default worker URL from `import.meta.url`, which a bundled build cannot answer. The derived
// path names a file the build never emits, and the Worker's SPA fallback answers it with index.html at status 200 —
// so the web worker starts, fails to parse HTML as a module, and dies with nothing logged. Vector tiles and glyph
// ranges are parsed in that worker while raster tiles decode on the main thread, so the symptom is a hillshade that
// draws and labels that never appear. The `?worker&url` import makes Vite emit a real worker entry and hand back its
// URL.
setWorkerUrl(maplibreWorkerURL)

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<App />)
