// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

import BrowserOnly from "@docusaurus/BrowserOnly"
import Link from "@docusaurus/Link"
import { PRICE_MONTHLY } from "@mailwoman/license-worker/client/constants"
import CodeBlock from "@theme/CodeBlock"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react"

import { CoverageTable } from "../components/CoverageTable/CoverageTable.tsx"
import { TourStops } from "../components/HeroMap/tour.ts"
import { HeroSearch } from "../components/HeroSearch/HeroSearch.tsx"
import { useSiteConfig } from "../hooks/site.ts"

import styles from "./index.module.css"

/**
 * How long the tour holds each stop, flight included.
 */
const STOP_DURATION_MS = 7000

const HeroMap = lazy(() => import("#components/HeroMap/HeroMap"))

const usePrefersReducedMotion = () => {
	const [reduced, setReduced] = useState(false)

	useEffect(() => {
		const query = globalThis.matchMedia("(prefers-reduced-motion: reduce)")
		const update = () => setReduced(query.matches)

		update()
		query.addEventListener("change", update)

		return () => query.removeEventListener("change", update)
	}, [])

	return reduced
}

function HomepageHeader(): ReactNode {
	const [index, setIndex] = useState(0)
	const [paused, setPaused] = useState(false)
	const reducedMotion = usePrefersReducedMotion()
	const stop = TourStops[index]!
	const holding = paused || reducedMotion

	useEffect(() => {
		if (holding) return

		const timer = globalThis.setTimeout(() => setIndex((current) => (current + 1) % TourStops.length), STOP_DURATION_MS)

		return () => globalThis.clearTimeout(timer)
	}, [index, holding])

	const [latitude, longitude] = [stop.coordinates[1], stop.coordinates[0]]

	return (
		<header className={styles.hero}>
			<div className={styles.heroMap} aria-hidden="true">
				<BrowserOnly>
					{() => (
						<Suspense fallback={null}>
							<HeroMap stop={stop} reducedMotion={reducedMotion} />
						</Suspense>
					)}
				</BrowserOnly>
			</div>

			<div className={clsx("container", styles.heroInner)}>
				<div className={clsx(styles.heroPanel, "mw-glass-surface")}>
					<p className={styles.heroEyebrow}>Open source · No API key · On your own devices</p>
					<Heading as="h1" className={styles.heroTitle}>
						Parse addresses. Find places. Run it yourself.
					</Heading>
					<p className={styles.heroSubtitle}>
						Install the parser and model from npm. Add local geographic data when you need coordinates. Run both in your
						own application or server.
					</p>

					<HeroSearch
						action="https://earth.mailwoman.post/"
						placeholder={stop.query}
						classes={{
							form: styles.heroSearch,
							input: styles.heroInput,
							submit: clsx("button button--primary", styles.heroSubmit),
							label: styles.visuallyHidden,
						}}
					/>

					<figure className={styles.heroResult} aria-live="polite">
						<figcaption className={styles.heroLandmark}>
							{stop.landmark}
							<span className={styles.heroTier}>{stop.tier}</span>
						</figcaption>
						<p className={styles.heroRecorded}>Recorded {stop.recordedOn}. Current Earth results may differ.</p>
						<p className={styles.heroTransform}>
							<span className={styles.heroIn} lang={stop.lang}>
								{stop.query}
							</span>
							<span className={styles.heroArrow} aria-hidden="true">
								→
							</span>
							<span className={styles.heroOut}>
								{latitude.toFixed(4)}, {longitude.toFixed(4)}
							</span>
						</p>
						<div className={styles.heroControls}>
							<div className={styles.heroDots} role="group" aria-label="Tour stops">
								{TourStops.map((candidate, candidateIndex) => (
									<button
										key={candidate.query}
										type="button"
										className={clsx(styles.heroDot, candidateIndex === index && styles.heroDotCurrent)}
										aria-label={candidate.landmark}
										aria-pressed={candidateIndex === index}
										onClick={() => setIndex(candidateIndex)}
									/>
								))}
							</div>
							{reducedMotion ? null : (
								<button
									type="button"
									className={styles.heroPause}
									aria-label={paused ? "Resume tour" : "Pause tour"}
									title={paused ? "Resume tour" : "Pause tour"}
									onClick={() => setPaused((value) => !value)}
								>
									<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
										{paused ? <path d="m8 5 11 7-11 7Z" /> : <path d="M6 5h4v14H6zM14 5h4v14h-4z" />}
									</svg>
								</button>
							)}
						</div>
					</figure>
				</div>
			</div>
		</header>
	)
}

function Benefits(): ReactNode {
	return (
		<section className={styles.benefits} aria-label="Why choose Mailwoman">
			<div className={clsx("container", styles.benefitRow)}>
				<div>
					<h2>Keep address processing local</h2>
					<p>Run the parser and local geocoder in your own application or server.</p>
				</div>
				<div>
					<h2>More lookups. Same price.</h2>
					<p>The commercial license has no per-address fee. Hosting and data costs depend on your setup.</p>
				</div>
				<div>
					<h2>Build it into your app</h2>
					<p>Use the same address engine in Node.js, in a browser, or from the command line.</p>
				</div>
			</div>
		</section>
	)
}

function HowItWorks(): ReactNode {
	return (
		<section className={clsx("container", styles.section)}>
			<Heading as="h2" className={styles.sectionHeading}>
				How a lookup works
			</Heading>
			<ol className={styles.steps}>
				<li>
					<h3>Parse</h3>
					<p>
						The parser labels parts of the address text and returns their positions in the normalized text. The
						published model runs in Node.js or a browser.
					</p>
					<code>"apt 4b 350 5th ave" → unit · house_number · street</code>
				</li>
				<li>
					<h3>Resolve</h3>
					<p>
						With local geographic data installed, the geocoder uses the parsed text to select a place or coordinate
						where the data supports one.
					</p>
					<code>parsed text + local geographic data → place or coordinate</code>
				</li>
				<li>
					<h3>Keep the receipt</h3>
					<p>
						Inspect the returned resolution tier and provenance fields before using a coordinate. A city or region
						result gives that place's representative point.
					</p>
					<code>resolution tier · source · coordinate</code>
				</li>
			</ol>
		</section>
	)
}

function Coverage(): ReactNode {
	return (
		<section className={clsx("container", styles.section)}>
			<Heading as="h2" className={styles.sectionHeading}>
				Where it resolves
			</Heading>
			<p className={styles.sectionLead}>
				Explore the published coverage table for available city, region, and street data, alongside the addresses used
				to evaluate parsing.
			</p>
			<CoverageTable />
		</section>
	)
}

const SOLUTIONS: readonly { to: string; title: string; body: string }[] = [
	{
		to: "/solutions#inspect-an-address-entered-in-a-form",
		title: "Inspect an address from a form",
		body: "Show which components the published parser read from the entered text.",
	},
	{
		to: "/solutions#prepare-irregular-records-for-review",
		title: "Review irregular records",
		body: "Normalize input and route incomplete parses to a review queue.",
	},
	{
		to: "/solutions#check-a-parsed-record-against-your-intake-policy",
		title: "Check an intake policy",
		body: "Apply explicit component and ZIP Code shape rules to parsed records.",
	},
	{
		to: "/solutions#compare-candidate-duplicate-addresses",
		title: "Compare candidate duplicates",
		body: "Block and score address pairs, then inspect uncertain matches.",
	},
	{
		to: "/solutions#add-fields-to-a-coordinate-you-already-have",
		title: "Annotate a supplied coordinate",
		body: "Format a coordinate and country code your application already has.",
	},
]

function SolutionFinder(): ReactNode {
	return (
		<section className={clsx("container", styles.section, styles.solutionSection)}>
			<Heading as="h2" className={styles.sectionHeading}>
				What will you build with Mailwoman?
			</Heading>
			<p className={styles.sectionLead}>Choose a task with an executed guide and inspect the limits of its result.</p>
			<div className={styles.solutions}>
				{SOLUTIONS.map((solution) => (
					<Link key={solution.to} to={solution.to} className={styles.solution}>
						<strong>{solution.title}</strong>
						<span>{solution.body}</span>
						<span className={styles.solutionArrow} aria-hidden="true">
							→
						</span>
					</Link>
				))}
			</div>
		</section>
	)
}

function PricingTeaser(): ReactNode {
	return (
		<section className={styles.teaser}>
			<div className={clsx("container", styles.teaserInner)}>
				<div>
					<Heading as="h2" className={styles.teaserTitle}>
						Free under the AGPL. Commercial licensing is {PRICE_MONTHLY} a month.
					</Heading>
					<p>
						The license has no seat or per-address charge for eligible companies. Hosting and data costs are separate.
					</p>
				</div>
				<Link className="button button--primary button--lg" to="/pricing">
					See the pricing
				</Link>
			</div>
		</section>
	)
}

function FeaturedWork(): ReactNode {
	return (
		<section className={styles.featured}>
			<div className="container">
				<Heading as="h2" className={styles.featuredSectionHeading}>
					See what address data can do
				</Heading>
				<div className={clsx("row", styles.featuredRow)}>
					<div className="col col--6">
						<Link to="/research/provider-registry-meets-usf" className={styles.featuredImageLink}>
							<img
								src="/img/provider-registry-usf.png"
								alt="Three provider datasets resolved onto one map of Texas."
								className={styles.featuredImage}
								loading="lazy"
							/>
						</Link>
					</div>
					<div className="col col--6">
						<p className={styles.cardJob}>Coverage reconciliation</p>
						<Heading as="h3" className={styles.featuredTitle}>
							The provider registry meets the Universal Service Fund
						</Heading>
						<p className={styles.featuredBody}>
							Three public datasets — a national provider registry, an FCC funding file, a state licensing list — that
							share no identifier. Resolved onto one map by matching the geocoded place, not the key none of them carry.
							Every dot is a real entity that turned up in more than one of them.
						</p>
						<p className={styles.cardLinks}>
							<Link to="/research/provider-registry-meets-usf">See how it's done →</Link>
						</p>
					</div>
				</div>
				<div className={clsx("row", styles.featuredRow, styles.featuredRowAlt)}>
					<div className="col col--6">
						<p className={styles.cardJob}>Data provenance</p>
						<Heading as="h3" className={styles.featuredTitle}>
							Inspect the source behind a matched point
						</Heading>
						<p className={styles.featuredBody}>
							The New York address-point map colors each plotted point by its recorded dataset: the federal National
							Address Database statewide and OpenAddresses in New York City. A geocode result can include the matched
							row's source and release. Coarser place results may have no source stamp for their selected coordinate.
						</p>
						<p className={styles.cardLinks}>
							<Link to="/research/keep-the-receipt">Explore the New York source map →</Link>
						</p>
					</div>
					<div className="col col--6">
						<Link to="/research/keep-the-receipt" className={styles.featuredImageLink}>
							<img
								src="/img/address-provenance-ny.png"
								alt="Address points across New York, colored by source dataset."
								className={styles.featuredImage}
								loading="lazy"
							/>
						</Link>
					</div>
				</div>
			</div>
		</section>
	)
}

function QuickStart(): ReactNode {
	return (
		<section className={styles.codeSection}>
			<div className="container">
				<Heading as="h2">Quick start</Heading>
				<div className={clsx("row", styles.codeRow)}>
					<div className="col col--6">
						<h4>JavaScript &amp; TypeScript</h4>
						<CodeBlock language="bash">{`npm install \\
  mailwoman@11.0.0 \\
  @mailwoman/neural@11.0.0 \\
  @mailwoman/neural-weights-en-us@11.0.0`}</CodeBlock>
						<CodeBlock language="js">
							{`import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({
  locale: "en-US",
})
const parse = createRuntimePipeline({ classifier })

const result = await parse(
  "apt 4b 350 5th ave new york ny 10118",
)
console.log("normalized:", result.tree.raw)

function printNode(node, depth = 0) {
  console.log("  ".repeat(depth) + node.tag + ": " + JSON.stringify(node.value))
  for (const child of node.children) printNode(child, depth + 1)
}

for (const root of result.tree.roots) printNode(root)`}
						</CodeBlock>
					</div>
					<div className="col col--6">
						<h4>Published 11.0.0 result</h4>
						<CodeBlock language="text">{`normalized: Apt 4B 350 5TH Ave New York NY 10118
region: "NY"
  locality: "New York"
    street: "5TH"
      unit: "Apt 4B"
      house_number: "350"
      street_suffix: "Ave"
    postcode: "10118"`}</CodeBlock>
						<p>
							The first-parse tutorial prints the complete tree, including each label&apos;s position in the normalized
							text. Geocoding needs a separate geographic data layer.
						</p>
						<p>
							<Link to="/docs/start">Run the first parse →</Link>
						</p>
					</div>
				</div>
			</div>
		</section>
	)
}

/**
 * Renders the documentation site's home page.
 */
export default function Home(): ReactNode {
	const { title } = useSiteConfig()

	return (
		<Layout
			title={title}
			description="Parse addresses with the published npm packages. Add local geographic data to find places and coordinates. Run Mailwoman in your own application or server."
		>
			<HomepageHeader />
			<main>
				<Benefits />
				<HowItWorks />
				<SolutionFinder />
				<Coverage />
				<QuickStart />
				<FeaturedWork />
				<PricingTeaser />
			</main>
		</Layout>
	)
}
