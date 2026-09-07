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

// MapLibre derives its default worker URL from `import.meta.url`, which a bundled build cannot answer; without an
// explicit worker the map composes its style and never requests a tile. The worker imports a shared sibling chunk, so
// Vite bundles it as a worker entry and hands back the emitted file's URL.
setWorkerUrl(maplibreWorkerURL)

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<App />)
