// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { setWorkerUrl } from "maplibre-gl"
import maplibreWorkerURL from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { createRoot } from "react-dom/client"

import { App } from "./App.tsx"

// In a bundled build, MapLibre's default worker URL points at a file that Vite never emits,
// and the preview server answers it with index.html.
// The `?worker&url` import makes Vite emit the worker and return its URL,
// so the GeoJSON sources of the routes and districts are parsed.
setWorkerUrl(maplibreWorkerURL)

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<App />)
