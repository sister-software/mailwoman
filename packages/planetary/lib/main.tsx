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

// In a bundled build, MapLibre's default worker URL points at a file that Vite never emits.
// The SPA fallback serves index.html for it, and the worker then fails silently.
// Without the worker, vector tiles and labels never render.
// The `?worker&url` import makes Vite emit the worker and return its URL.
setWorkerUrl(maplibreWorkerURL)

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<App />)
