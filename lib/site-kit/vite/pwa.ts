// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The installable-PWA options every mailwoman site shares: `injectManifest` over
 *   `lib/service-worker.ts`, a precache of the shell and its hashed assets only,
 *   plus a manifest whose identity is the origin.
 *
 *   A model, a gazetteer database or a tile is never precached. those stay range-fetched on demand.
 *
 *   `registerType: "prompt"` means a deploy's worker installs and waits.
 *   Earth's worker takes over when the page posts `SKIP_WAITING` from its update notice,
 *   through `registerServiceWorkerUpdates` in `site-kit/service-worker-client.ts`.
 *
 *   The planetary worker handles no such message, so its new worker takes over
 *   once every tab of the old one has closed.
 */

import type { ManifestOptions, VitePWAOptions } from "vite-plugin-pwa"

export interface PWAIdentity {
	/**
	 * The origin with a trailing slash, e.g. `https://earth.mailwoman.post/`.
	 *
	 * It is the manifest `id`, which is what keeps the three sites' installations distinct.
	 */
	origin: string
	name: string
	shortName: string
	themeColor: string
	/**
	 * The manifest `description`.
	 *
	 * Without it `vite-plugin-pwa` copies the workspace's `package.json` description.
	 * That description is written for developers.
	 */
	description?: string
	categories?: string[]
	/**
	 * A 512-pixel square icon whose artwork sits inside the central 80%,
	 * for platforms that crop icons to their own shape.
	 *
	 * A site without one declares only `any` icons, because a platform that crops an
	 * unpadded icon to a circle or squircle removes the edges of its artwork.
	 */
	maskableIcon?: string
	screenshots?: ManifestOptions["screenshots"]
}

export function installablePWA(identity: PWAIdentity): Partial<VitePWAOptions> {
	const maskable = identity.maskableIcon
		? [{ src: identity.maskableIcon, sizes: "512x512", type: "image/png", purpose: "maskable" }]
		: []

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
			...(identity.description ? { description: identity.description } : {}),
			...(identity.categories ? { categories: identity.categories } : {}),
			start_url: "/",
			scope: "/",
			display: "standalone",
			orientation: "any",
			background_color: identity.themeColor,
			theme_color: identity.themeColor,
			icons: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
				...maskable,
			],
			...(identity.screenshots ? { screenshots: identity.screenshots } : {}),
		},
	}
}
