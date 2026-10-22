import BrowserOnly from "@docusaurus/BrowserOnly"
import Link from "@docusaurus/Link"
import { PRICE_MONTHLY } from "@mailwoman/license-worker/client/constants"
import CodeBlock from "@theme/CodeBlock"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react"

import { RECORDED_ON, TourStops } from "../components/HeroMap/tour.ts"
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
				<div className={styles.heroPanel}>
					<p className={styles.heroEyebrow}>Open source · No API key · Runs in your process</p>
					<Heading as="h1" className={styles.heroTitle}>
						Every address, resolved on your own machines.
					</Heading>
					<p className={styles.heroSubtitle}>
						A neural address parser and an open-data geocoder in one npm install. Nothing leaves your network, and
						nothing is metered.
					</p>

					<form className={styles.heroSearch} action="https://earth.mailwoman.ai/" method="get" role="search">
						<label htmlFor="hero-query" className={styles.visuallyHidden}>
							An address to geocode
						</label>
						<input
							id="hero-query"
							name="q"
							type="search"
							className={styles.heroInput}
							placeholder={stop.query}
							autoComplete="street-address"
						/>
						<button type="submit" className={clsx("button button--primary", styles.heroSubmit)}>
							Geocode
						</button>
					</form>

					<figure className={styles.heroResult} aria-live="polite">
						<figcaption className={styles.heroLandmark}>
							{stop.landmark}
							<span className={styles.heroTier}>{stop.tier}</span>
						</figcaption>
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
								<button type="button" className={styles.heroPause} onClick={() => setPaused((value) => !value)}>
									{paused ? "Resume tour" : "Pause tour"}
								</button>
							)}
						</div>
					</figure>
					<p className={styles.heroFine}>Answers recorded from Earth, the in-browser build, on {RECORDED_ON}.</p>
				</div>
			</div>
		</header>
	)
}

/**
 * The figures behind the hero's claims, each one measured on the reference page it links to.
 */
function Stats(): ReactNode {
	return (
		<section className={styles.stats}>
			<dl className={clsx("container", styles.statRow)}>
				<div>
					<dt>The model</dt>
					<dd>39.4 MB</dd>
					<p>An int8 encoder that ships inside an npm package.</p>
				</div>
				<div>
					<dt>The global gazetteer</dt>
					<dd>2.88 GB</dd>
					<p>A download you keep, not a service you call.</p>
				</div>
				<div>
					<dt>Requests to us</dt>
					<dd>0</dd>
					<p>The lookup runs in your process and reports nothing back.</p>
				</div>
				<div>
					<dt>Commercial license</dt>
					<dd>{PRICE_MONTHLY}</dd>
					<p>A month, per company, at any volume.</p>
				</div>
			</dl>
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
						A six-layer encoder labels each piece of the text: house number, street, unit, city, postcode and the rest,
						each with a confidence. It runs on ONNX Runtime in Node or in a browser tab.
					</p>
					<code>"apt 4b 350 5th ave" → unit · house_number · street</code>
				</li>
				<li>
					<h3>Resolve</h3>
					<p>
						The components resolve against a gazetteer on your own disk, built from{" "}
						<a href="https://whosonfirst.org">Who&apos;s On First</a>, OpenAddresses and national registers, down to the
						address point where the data has one.
					</p>
					<code>street + city + postcode → 40.7478, -73.9850</code>
				</li>
				<li>
					<h3>Keep the receipt</h3>
					<p>
						Every answer names its tier and the dataset it came from, so a coarse match reads as coarse and you can
						trace any coordinate back to its source.
					</p>
					<code>placetype: interpolated · precision: ±64 m</code>
				</li>
			</ol>
		</section>
	)
}

const SOLUTIONS: readonly { to: string; title: string; body: string }[] = [
	{
		to: "/docs/solutions/eliminate-the-per-request-bill",
		title: "My geocoding bill grows with every customer",
		body: "A flat license does not move when the volume does.",
	},
	{
		to: "/docs/solutions/keep-addresses-inside",
		title: "Addresses can't leave our network",
		body: "An in-process geocode opens no socket, so there is no third-party flow to paper.",
	},
	{
		to: "/docs/solutions/resolve-a-messy-file",
		title: "I have a messy customer file",
		body: "Parse, geocode and match in one pipeline, joined on the coordinate.",
	},
	{
		to: "/docs/solutions/fleet-reverse-geocoding",
		title: "I reverse-geocode a fleet",
		body: "A local reverse lookup is bounded by disk and CPU, not by a quota.",
	},
	{
		to: "/docs/solutions/own-what-you-look-up",
		title: "I need to keep the results",
		body: "A result computed on your own disk is an output you own.",
	},
	{
		to: "/docs/solutions/research-and-teaching",
		title: "I'm doing research or teaching",
		body: "Free under the AGPL, with a declared key for every data tier.",
	},
]

function SolutionFinder(): ReactNode {
	return (
		<section className={clsx("container", styles.section)}>
			<Heading as="h2" className={styles.sectionHeading}>
				What brings you here?
			</Heading>
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
						Free under the AGPL. {PRICE_MONTHLY} a month to keep your source closed.
					</Heading>
					<p>
						No seats, no per-address fees, and no meter. Your thousandth lookup and your hundred-millionth cost the
						same.
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
					Worked examples, on real public data
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
							We keep the receipt on every coordinate
						</Heading>
						<p className={styles.featuredBody}>
							Every point Mailwoman resolves to remembers which open dataset it came from. Here's New York: the federal
							National Address Database statewide, OpenAddresses (the city's own data) in New York City. Most geocoders
							sand that provenance off. We keep it on the point.
						</p>
						<p className={styles.cardLinks}>
							<Link to="/research/keep-the-receipt">See how it's done →</Link>
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
						<h4>Library</h4>
						<CodeBlock language="bash">
							npm install mailwoman @mailwoman/neural @mailwoman/neural-weights-en-us
						</CodeBlock>
						<CodeBlock language="js">
							{`import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const result = await parse("apt 4b 350 5th ave new york ny 10118")
// result.tree.roots — nested by geographic containment:
//   region "NY" › locality "New York" › street "5TH"
//     › unit "Apt 4B" · house_number "350" · street_suffix "Ave"
//   …and postcode "10118" under the locality`}
						</CodeBlock>
					</div>
					<div className="col col--6">
						<h4>CLI</h4>
						<CodeBlock language="bash">{`npx mailwoman parse "350 5th Ave, New York, NY 10118"`}</CodeBlock>
						<CodeBlock language="json">
							{`{
  "region": "NY",
  "locality": "New York",
  "street": "5th",
  "house_number": "350",
  "street_suffix": "Ave",
  "postcode": "10118"
}`}
						</CodeBlock>
						<p>
							No coordinates in that output, because geocoding needs the gazetteer.{" "}
							<Link to="/docs/developers/get-started/ten-minute-trial">Your first ten minutes</Link> covers what you get
							out of the box and what still needs a download.
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
			description="An address parser and geocoder that runs in your own process. It needs no API key or server: a neural parser plus an open-data resolver, in Node or entirely in your browser."
		>
			<HomepageHeader />
			<main>
				<Stats />
				<HowItWorks />
				<SolutionFinder />
				<QuickStart />
				<FeaturedWork />
				<PricingTeaser />
			</main>
		</Layout>
	)
}
