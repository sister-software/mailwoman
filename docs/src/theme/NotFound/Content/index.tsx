/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The 404 body, ejected from `@docusaurus/theme-classic`.
 *
 *   Upstream's copy is "Please contact the owner of the site that linked you to the original URL and let them know
 *   their link is broken." On our own 404s the owner is us, so that sentence asks the visitor to report the problem to
 *   the wrong person and offers them nowhere to go. This says what happened and hands over the four doors plus the
 *   routes people actually guess — `/pricing` and `/license` now redirect, but a mistyped doc path still lands here.
 */

import Link from "@docusaurus/Link"
import { useLocation } from "@docusaurus/router"
import Heading from "@theme/Heading"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./styles.module.css"

interface Destination {
	to: string
	label: string
	blurb: string
}

const DESTINATIONS: readonly Destination[] = [
	{
		to: "/docs/developers/get-started/what-mailwoman-is",
		label: "Get started",
		blurb: "What Mailwoman is, installed and parsing in ten minutes.",
	},
	{
		to: "/docs/pricing",
		label: "Pricing",
		blurb: "Free under the AGPL, or a flat commercial license.",
	},
	{
		to: "/docs/developers/reference/http-apis",
		label: "Reference",
		blurb: "The CLI, the HTTP APIs and the runtime flags.",
	},
	{
		to: "/research",
		label: "Field notes",
		blurb: "Iteration notes and design log entries.",
	},
]

export default function NotFoundContent({ className }: { className?: string }): ReactNode {
	const { pathname } = useLocation()

	return (
		<main className={clsx("container margin-vert--xl", className)}>
			<div className="row">
				<div className="col col--8 col--offset-2">
					<Heading as="h1" className="hero__title">
						No page at this address
					</Heading>

					<p className={styles.lede}>
						Nothing is published at <code className={styles.path}>{pathname}</code>. The page may have moved when the
						docs were reorganised, or the address may have a typo in it.
					</p>

					<p className={styles.lede}>
						Press <kbd>⌘</kbd> <kbd>K</kbd> to search the site, or start from one of these:
					</p>

					<ul className={styles.doors}>
						{DESTINATIONS.map((destination) => (
							<li key={destination.to}>
								<Link to={destination.to} className={styles.door}>
									<strong>{destination.label}</strong>
									<span>{destination.blurb}</span>
								</Link>
							</li>
						))}
					</ul>

					<p className={styles.report}>
						If a link on this site sent you here, that is ours to fix —{" "}
						<Link href="https://github.com/sister-software/mailwoman/issues/new">open an issue</Link> and say which page
						you came from.
					</p>
				</div>
			</div>
		</main>
	)
}
