/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   /license/issued — the page Stripe returns a buyer to. Browser-only: it reads `session_id` from the query and polls
 *   the license worker's claim route. A page that renders a key is not for search engines.
 */

import BrowserOnly from "@docusaurus/BrowserOnly"
import Head from "@docusaurus/Head"
import Layout from "@theme/Layout"
import type React from "react"

import { IssuedLicense } from "../../components/License/IssuedLicense.tsx"

const IssuedPage: React.FC = () => (
	<Layout
		title="Your license"
		description="The page Stripe returns you to after payment: your key, once your payment is confirmed."
	>
		<Head>
			<meta name="robots" content="noindex" />
		</Head>
		<main style={{ padding: "2rem", maxWidth: 800, margin: "0 auto" }}>
			<h1>Your license</h1>
			<BrowserOnly fallback={<p>Loading…</p>}>
				{() => <IssuedLicense sessionID={new URLSearchParams(globalThis.location.search).get("session_id")} />}
			</BrowserOnly>
		</main>
	</Layout>
)

export default IssuedPage
