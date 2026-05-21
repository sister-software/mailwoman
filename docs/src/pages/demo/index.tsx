import BrowserOnly from "@docusaurus/BrowserOnly"
import DashboardMap from "@mailwoman/docs/components/DashboardMap/DashboardMap"
import Layout from "@theme/Layout"
import "maplibre-gl/dist/maplibre-gl.css"
import React from "react"
import styles from "./styles.module.css"

const DemoPage: React.FC = () => {
	return (
		<Layout title="Demo" description="Client-side address geocoder demo for mailwoman.">
			<main className={styles.demoRoot}>
				<header className={styles.header}>
					<h1>Mailwoman geocoder demo</h1>
					<p>
						Type a US address. The neural classifier (~25 MB ONNX) and WOF locality DB (~35 MB SQLite) run entirely in
						your browser — no server round-trips after the initial asset load.
					</p>
				</header>
				<BrowserOnly fallback={<p>Loading…</p>}>{() => <DashboardMap />}</BrowserOnly>
			</main>
		</Layout>
	)
}

export default DemoPage
