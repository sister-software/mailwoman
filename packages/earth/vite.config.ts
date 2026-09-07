/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Earth build: React, the PWA manifest and service worker, and `build.json`. There is no server side; every
 *   output is a static asset Cloudflare serves without invoking a Worker.
 */

import { buildInfoPlugin } from "@mailwoman/site-kit/vite/build-info"
import { installablePWA } from "@mailwoman/site-kit/vite/pwa"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
	plugins: [
		react(),
		VitePWA(
			installablePWA({
				origin: "https://earth.mailwoman.ai/",
				name: "Mailwoman Earth",
				shortName: "Earth",
				themeColor: "#0b1020",
			})
		),
		buildInfoPlugin({ app: "mailwoman-earth" }),
	],
	build: {
		outDir: "dist",
		sourcemap: true,
	},
	server: { port: 7781, strictPort: true },
})
