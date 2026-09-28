/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The training metrics page uses a full-page layout with the TrainingCharts dashboard. It mirrors the demo page
 *   pattern: a Layout header and a BrowserOnly boundary. It also has a build-commit footer.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import Layout from "@theme/Layout"
import React from "react"

import { TrainingCharts } from "../../components/TrainingCharts/TrainingCharts.tsx"
import { useSiteConfig } from "../../hooks/site.ts"

import styles from "./styles.module.css"

const TrainingPage: React.FC = () => {
	const { buildCommit, buildTimeDisplay } = useSiteConfig()

	return (
		<Layout
			title="Training"
			description="Interactive training metrics dashboard for the Mailwoman neural address parser."
		>
			<main className={styles.trainingRoot}>
				<header className={styles.header}>
					<h1>Training metrics</h1>
					<p>
						Live training loss, validation F1, and per-component metrics pulled from the Trackio API. Select runs and
						metrics to compare training progress.
					</p>
				</header>
				<BrowserOnly fallback={<p>Loading training charts…</p>}>{() => <TrainingCharts />}</BrowserOnly>
				<footer
					style={{
						marginTop: "2rem",
						padding: "1rem 0",
						opacity: 0.4,
						fontSize: "0.75rem",
						textAlign: "center",
					}}
				>
					Build {buildCommit} · {buildTimeDisplay}
				</footer>
			</main>
		</Layout>
	)
}

export default TrainingPage
