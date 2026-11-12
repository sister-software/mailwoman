// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import { registerServiceWorkerUpdates } from "@mailwoman/universe/site-kit/service-worker-client"
import { setWorkerUrl } from "maplibre-gl"
import maplibreWorkerURL from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"
import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

import { PRODUCTION_CONFIG } from "#config"
import { loadMemoryProfile } from "#memory/profile"
import { pathWithReadableCamera } from "#routes"
import { prefetchReleasesManifest } from "#runtime/use/geocoder-runtime"
import { remoteGeocoderURL } from "#runtime/use/remote-geocoder-runtime"

import { App } from "./App.tsx"
import { UpdateNotice } from "./UpdateNotice.tsx"

// A reload arrives at the percent-encoded camera path the static-asset server redirects to.
const readablePath = pathWithReadableCamera(new URL(location.href))

if (readablePath) {
	history.replaceState(history.state, "", readablePath)
}

// The trace page loads the classifier in either mode, and it starts its own manifest fetch.
if (!remoteGeocoderURL(PRODUCTION_CONFIG)) {
	prefetchReleasesManifest()
}

// MapLibre derives its default worker URL from `import.meta.url`, which a bundled build cannot answer.
// Without an explicit worker the map composes its style and never requests a tile.
// The worker imports a shared sibling chunk, so Vite bundles it as a worker entry
// and hands back the emitted file's URL.
setWorkerUrl(maplibreWorkerURL)

// A deploy's worker waits until the reader picks "Reload" in the update notice.
const updates = registerServiceWorkerUpdates(registerSW)

// The crash guard's reading decides whether this load mounts 3D, so it settles before the first render.
await loadMemoryProfile()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(
	<>
		<App />
		<UpdateNotice updates={updates} />
	</>
)
