/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The installable-PWA options every mailwoman site shares: `injectManifest` over `lib/service-worker.ts`, a precache
 *   of the shell and its hashed assets only, and a manifest whose identity is the origin. A model, a gazetteer
 *   database or a tile is never precached; those stay range-fetched on demand.
 */

import type { VitePWAOptions } from "vite-plugin-pwa"

export interface PWAIdentity {
	/**
	 * The origin with a trailing slash, e.g. `https://earth.mailwoman.ai/`. It is the manifest `id`, which is what keeps
	 * the three sites' installations distinct.
	 */
	origin: string
	name: string
	shortName: string
	themeColor: string
}

export function installablePWA(identity: PWAIdentity): Partial<VitePWAOptions> {
	return {
		strategies: "injectManifest",
		srcDir: "lib",
		filename: "service-worker.ts",
		registerType: "prompt",
		injectManifest: {
			globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
		},
		manifest: {
			id: identity.origin,
			name: identity.name,
			short_name: identity.shortName,
			start_url: "/",
			scope: "/",
			display: "standalone",
			background_color: identity.themeColor,
			theme_color: identity.themeColor,
			icons: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
			],
		},
	}
}
