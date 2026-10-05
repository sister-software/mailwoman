/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The opportunity application's build: a static bundle for the local preview server. Node reads
 *   `OPPORTUNITY_BASEMAP_URL` here and compiles it into the client as `__OPPORTUNITY_BASEMAP_URL__`, or `null`
 *   when it is unset. The build registers no service worker and writes no deployment record.
 */

import { stringifyJSON } from "@mailwoman/core/json"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// The package's own `#` map rather than `./lib/…`: the config sits outside `lib/`, so a relative
// path into the emitting project cannot be rewritten by the test project that checks this file.
import { $public } from "#env"

export default defineConfig({
	define: { __OPPORTUNITY_BASEMAP_URL__: stringifyJSON($public.OPPORTUNITY_BASEMAP_URL ?? null) },
	plugins: [react()],
	build: {
		outDir: "dist",
		sourcemap: true,
	},
	server: { port: 7792, strictPort: true },
})
