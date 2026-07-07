/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   /trace — follow an address through the neural decode path. Loads the same production model
 *   assets as /demo (DemoEmbedProvider) and renders the four-band ModelVisualizer live.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import Layout from "@theme/Layout"
import type React from "react"

import { LiveModelVisualizer } from "../components/ModelVisualizer/LiveModelVisualizer.tsx"
import { DemoEmbedProvider } from "../contexts/DemoEmbed.tsx"
import { useSiteConfig } from "../hooks/site.ts"

const TracePage: React.FC = () => {
	const { baseURL } = useSiteConfig()

	const sqljsBaseURL = `${baseURL}mailwoman/sqljs`

	return (
		<Layout title="Trace" description="Follow an address through the mailwoman neural decode path">
			<main style={{ padding: "2rem", maxWidth: 1100, margin: "0 auto" }}>
				<h1>Trace a parse</h1>
				<p>
					Type an address and watch it move through the model: tokens, retrieval channels, emissions, and the decoded
					result — including every prior and repair pass that shaped it.
				</p>
				<BrowserOnly fallback={<p>Loading…</p>}>
					{() => (
						<DemoEmbedProvider sqljsBaseURL={sqljsBaseURL}>
							<LiveModelVisualizer />
						</DemoEmbedProvider>
					)}
				</BrowserOnly>
			</main>
		</Layout>
	)
}

export default TracePage
