/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `/demo-next` — the PARALLEL STAGING route for the geocoder-demo port (phase 5a). It renders the
 *   package's `@mailwoman/react/map` `<GeocoderDemo>` driven by the REAL runtime (`useDemoNextRuntime`),
 *   over the same R2 assets the live `/demo` page uses — so the two can be screenshot-compared before the
 *   default `/demo` route is ever flipped.
 *
 *   This route is deliberately UNLISTED: it is not in the navbar and is excluded from the sitemap
 *   (`docusaurus.config.ts` sitemap `ignorePatterns`) + carries a `noindex` robots hint. The live
 *   `/demo` page (`../demo/index.tsx`, `../demo/_app.tsx`) is NOT touched by this file.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/styles.css"
import BrowserOnly from "@docusaurus/BrowserOnly"
import Head from "@docusaurus/Head"
import { GeocoderDemo } from "@mailwoman/react/map"
import type { DemoPanels } from "@mailwoman/react/map"
import type { Coordinates2D } from "@mailwoman/spatial"
import Layout from "@theme/Layout"
import type React from "react"
import { useMemo } from "react"

import { AboutDemo } from "../../components/AboutDemo/AboutDemo.tsx"
import { PermalinkButton } from "../../components/PermalinkButton/PermalinkButton.tsx"
import { useSiteConfig } from "../../hooks/site.ts"
import { DEFAULT_ADDRESS, EXAMPLE_ADDRESSES } from "../../shared/demo-helpers.ts"
import { useBrowserGeolocation } from "../demo/_hooks.tsx"
import { TILE_WORKER_URL } from "../demo/_map-helpers.ts"
import { DemoNextCompare } from "./_compare.tsx"
import { useDemoNextRuntime } from "./_runtime.ts"

import demoStyles from "../demo/styles.module.css"

const PRESETS = EXAMPLE_ADDRESSES.map((ex) => ({ label: ex.label, value: ex.address }))

const LoadingFallback: React.FC = () => <p style={{ padding: "1rem" }}>Loading…</p>

function initialAddress(): string {
	if (typeof window === "undefined") return DEFAULT_ADDRESS

	return new URL(window.location.href).searchParams.get("q") ?? DEFAULT_ADDRESS
}

/** The client-only demo body: build the real runtime, then render `<GeocoderDemo>` with docs panels. */
const DemoNextInner: React.FC<{ initialCenter: Coordinates2D }> = ({ initialCenter }) => {
	const { baseURL } = useSiteConfig()
	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`
	const { runtime, releases, forceWASM } = useDemoNextRuntime({ sqljsBaseURL, baseURL, initialCenter })

	const selectedVersion = runtime?.selectedVersion ?? null
	const selectedRelease = releases.find((r) => r.version === selectedVersion)

	const panels = useMemo<DemoPanels>(
		() => ({
			header: <AboutDemo />,
			releaseInfo: selectedRelease ? (
				<p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", opacity: 0.75 }}>
					<strong>{selectedRelease.version}</strong> — {selectedRelease.description} ({selectedRelease.modelSize},{" "}
					{selectedRelease.tokenizerVocab.toLocaleString()} vocab, {selectedRelease.steps.toLocaleString()} steps)
				</p>
			) : undefined,
			permalink: (text) => <PermalinkButton text={text} />,
			compare: (ctx) => (
				<DemoNextCompare
					primary={ctx.result}
					compareMode={ctx.compareMode}
					compareVersion={ctx.compareVersion}
					primaryVersion={selectedVersion ?? "?"}
					releases={releases}
					forceWASM={forceWASM}
				/>
			),
		}),
		[selectedRelease, selectedVersion, releases, forceWASM]
	)

	if (!runtime) return <LoadingFallback />

	return <GeocoderDemo runtime={runtime} panels={panels} defaultAddress={initialAddress()} presets={PRESETS} />
}

const DemoNextPage: React.FC = () => {
	const { baseURL } = useSiteConfig()
	const initialCenter = useBrowserGeolocation()

	return (
		<Layout
			title="Demo (next)"
			description="Staging build of the mailwoman geocoder demo on @mailwoman/react."
			noFooter
		>
			<Head>
				{/* Unlisted staging route — keep it out of search indexes (also excluded from the sitemap). */}
				<meta name="robots" content="noindex" />
				<link rel="preconnect" href="https://public.sister.software" crossOrigin="anonymous" />
				<link rel="dns-prefetch" href="https://public.sister.software" />
				<link rel="preconnect" href={TILE_WORKER_URL} crossOrigin="anonymous" />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/index.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sqlite.worker.js`} />
				<link rel="prefetch" href={`${baseURL}mailwoman/sqljs/sql-wasm.wasm`} />
			</Head>

			<main className={demoStyles.demoRoot}>
				<BrowserOnly fallback={<LoadingFallback />}>
					{() => {
						if (!initialCenter) return <LoadingFallback />

						return <DemoNextInner initialCenter={initialCenter} />
					}}
				</BrowserOnly>
			</main>
		</Layout>
	)
}

export default DemoNextPage
