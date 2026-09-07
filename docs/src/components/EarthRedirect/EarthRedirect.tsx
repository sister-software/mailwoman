/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The geocoder lives at earth.mailwoman.ai. A retired docs route forwards a visitor there with their query intact
 *   (`location.replace` keeps `?q=`, which a `meta refresh` cannot), and shows the link for a client that does not
 *   run the script. GitHub Pages serves no server-side redirect, so this page is the redirect.
 */

import Head from "@docusaurus/Head"
import Layout from "@theme/Layout"
import { useEffect } from "react"

const EARTH = "https://earth.mailwoman.ai"

export interface EarthRedirectProps {
	/**
	 * The path on Earth this docs route maps to: `/`, `/debug` or `/trace`.
	 */
	path: "/" | "/debug" | "/trace"
}

export function EarthRedirect({ path }: EarthRedirectProps) {
	const target = `${EARTH}${path}`

	useEffect(() => {
		location.replace(`${target}${location.search}`)
	}, [target])

	return (
		<Layout title="Earth">
			<Head>
				<meta httpEquiv="refresh" content={`0;url=${target}`} />
				<link rel="canonical" href={target} />
			</Head>
			<main style={{ padding: "2rem" }}>
				<p>
					The geocoder has moved to <a href={target}>earth.mailwoman.ai</a>.
				</p>
			</main>
		</Layout>
	)
}
