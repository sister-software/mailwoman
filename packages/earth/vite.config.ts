// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The Earth build: React, the PWA manifest and service worker, plus `build.json`.
 *
 *   There's no server side.
 *   Every output is a static asset Cloudflare serves without invoking a Worker.
 */

import { buildCommitDefine, buildInfoPlugin } from "@mailwoman/universe/site-kit/vite/build-info"
import { installablePWA } from "@mailwoman/universe/site-kit/vite/pwa"
import { stageSQLiteRuntimePlugin } from "@mailwoman/universe/site-kit/vite/stage-sqlite-runtime"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
	// The service worker labels its caches after the build's commit, so a deploy starts each cache empty.
	define: await buildCommitDefine(),
	plugins: [
		react(),
		stageSQLiteRuntimePlugin("public/sqlite"),
		VitePWA(
			installablePWA({
				origin: "https://earth.mailwoman.post/",
				name: "Mailwoman",
				shortName: "Mailwoman",
				themeColor: "#0b1020",
				// index.html repeats this text in its description meta.
				description:
					"Type a messy address and see where it is. Mailwoman parses and geocodes on your device with a compact neural model and open map data, works offline once loaded, and shows how precise each answer is and where it came from.",
				categories: ["navigation", "utilities"],
				maskableIcon: "/icon-maskable-512.png",
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
