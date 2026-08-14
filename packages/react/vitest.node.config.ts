/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Node-mode vitest for `@mailwoman/react` — runs the PURE `*.node.test.ts` suites under bare node (no
 *   browser, no WebGL, no map). Their existence is the proof that the geometry (`map/geometry.ts`) and
 *   render-spec (`map/place-render.ts`) modules are side-effect-free and node-safe: if either grew a
 *   `react-map-gl` / `maplibre-gl` / DOM import, these tests would fail to even load here. The browser
 *   suite (`vitest.config.ts`) excludes these files, so this is the only entry that runs them.
 */

import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["**/*.node.test.ts"],
	},
})
