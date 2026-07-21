/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Vitest browser-mode config for `@mailwoman/react`. Runs the component + hook tests in a real
 *   headless Chromium via the Playwright provider — DOM APIs (clipboard, timers, layout) are genuine,
 *   which is the point: these components run in the browser, so they're tested there. Kept OUT of the
 *   repo-root `vitest.config.ts` sweep (that run excludes `react/**` test files), so this is the only
 *   entry that executes them.
 *
 *   WebGL via SwiftShader: `<DemoMap>` (react-map-gl/maplibre) needs a WebGL context, which headless
 *   Chromium lacks by default. The `--use-gl=angle --use-angle=swiftshader` flags (plus
 *   `--enable-unsafe-swiftshader`, required since Chromium began gating software WebGL behind it) route
 *   GL through the bundled SwiftShader software rasterizer so the map mounts a real canvas offscreen.
 *   The DemoMap test still guards the GL surface (asserts the component TREE, canvas only if present) so
 *   it can't flake if a future Chromium drops software GL — see `map/DemoMap.test.tsx`.
 */

import react from "@vitejs/plugin-react"
import { playwright } from "@vitest/browser-playwright"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
	plugins: [react()],
	test: {
		include: ["**/*.test.ts", "**/*.test.tsx"],
		// Pure `*.node.test.ts` run under bare node via `vitest.node.config.ts` (see `test:node`), NOT in the browser —
		// they prove the geometry/render-spec modules carry no DOM/webgl/react-map-gl dependency.
		exclude: [...configDefaults.exclude, "**/*.node.test.ts"],
		setupFiles: ["./test/setup.ts"],
		browser: {
			enabled: true,
			provider: playwright({
				launchOptions: {
					args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
				},
			}),
			headless: true,
			instances: [{ browser: "chromium" }],
		},
	},
})
