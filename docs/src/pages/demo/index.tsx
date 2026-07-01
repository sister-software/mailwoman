/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Mailwoman geocoder demo — fully client-side. Combines:
 *
 *   - `@mailwoman/neural-web` (onnxruntime-web, WASM SIMD with WebGPU fallback) for the BIO classifier.
 *   - Sql.js-httpvfs (../../shared/httpvfs-resolver) range-loading the same-origin WOF + polygon DBs.
 *   - `@mailwoman/cartographer` `StyleSpecificationComposer` over the v4 protomaps basemap.
 *
 *   The model/tokenizer/fst come from HF (one-shot full-fetch); the resolver DBs are served
 *   same-origin from `/mailwoman/` and range-loaded, so a session fetches a few MB of them, not
 *   70+.
 *
 *   Layout: full-viewport map (Google Maps-style) with a floating semi-transparent control panel on
 *   the left. On mobile the panel slides to the bottom.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import BrowserOnly from "@docusaurus/BrowserOnly"
import Head from "@docusaurus/Head"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import Layout from "@theme/Layout"
import type React from "react"

import { DemoApp } from "./_app.tsx"
import { useBrowserGeolocation } from "./_hooks.tsx"
import { TILE_WORKER_URL } from "./_map-helpers.ts"

import styles from "./styles.module.css"

const LoadingFallback: React.FC = () => {
	return <p>Loading…</p>
}

const DemoPage: React.FC = () => {
	const { siteConfig } = useDocusaurusContext()
	const buildCommit = (siteConfig.customFields?.buildCommit as string) ?? "?"
	const buildTimeDisplay = (siteConfig.customFields?.buildTimeDisplay as string) ?? "?"
	const initialCenter = useBrowserGeolocation()

	return (
		<Layout title="Demo" description="Client-side address geocoder demo for mailwoman." noFooter>
			{/* Resource hints: the DBs/model range-load from R2 and the basemap tiles from tiles.* the
			    moment the app boots — preconnecting here overlaps DNS+TLS with hydration. The sqljs
			    worker assets are same-origin and fetched on (or before) first lookup; prefetch warms
			    the HTTP cache at low priority. */}
			<Head>
				<link rel="preconnect" href="https://public.sister.software" crossOrigin="anonymous" />
				<link rel="dns-prefetch" href="https://public.sister.software" />
				<link rel="preconnect" href={TILE_WORKER_URL} crossOrigin="anonymous" />
				<link rel="prefetch" href={`${siteConfig.baseURL}mailwoman/sqljs/index.js`} />
				<link rel="prefetch" href={`${siteConfig.baseURL}mailwoman/sqljs/sqlite.worker.js`} />
				<link rel="prefetch" href={`${siteConfig.baseURL}mailwoman/sqljs/sql-wasm.wasm`} />
			</Head>

			<main className={styles.demoRoot}>
				<header className={styles.header}>
					<h1>Mailwoman geocoder demo</h1>
					<p>
						Type a US address. The neural classifier and supporting data run entirely in your browser — no server
						round-trips after the initial asset load.
					</p>
					<span className={styles.headerMeta}>
						Build {buildCommit} · {buildTimeDisplay}
					</span>
				</header>
			</main>

			<BrowserOnly fallback={<LoadingFallback />}>
				{() => {
					if (!initialCenter) return <LoadingFallback />

					return <DemoApp initialCenter={initialCenter} />
				}}
			</BrowserOnly>
		</Layout>
	)
}

export default DemoPage
