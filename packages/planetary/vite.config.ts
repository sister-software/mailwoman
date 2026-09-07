/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The planetary build: one source, compiled per body. `PLANETARY_BODY` is read here, under Node, and compiled into
 *   the client as `__PLANETARY_BODY__`; the body's icon set is the public directory; the PWA identity is the body's.
 *   There is no server side; every output is a static asset Cloudflare serves without invoking a Worker.
 */

// The package's own subpaths rather than `./lib/…`: the config sits outside `lib/`, so a relative path into the
// emitting project cannot be rewritten by the test project that checks this file.
import { BODY_CONFIGS } from "@mailwoman/planetary/bodies"
import { $public } from "@mailwoman/planetary/env"
import { buildInfoPlugin } from "@mailwoman/site-kit/vite/build-info"
import { installablePWA } from "@mailwoman/site-kit/vite/pwa"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

const body = $public.PLANETARY_BODY
const config = BODY_CONFIGS[body]

export default defineConfig({
	define: { __PLANETARY_BODY__: JSON.stringify(body) },
	publicDir: `public/icons/${body}`,
	plugins: [react(), VitePWA(installablePWA(config.identity)), buildInfoPlugin({ app: `mailwoman-${body}` })],
	build: {
		outDir: "dist",
		sourcemap: true,
	},
	server: { port: 7791, strictPort: true },
})
