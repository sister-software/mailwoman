import Link from "@docusaurus/Link"
import CodeBlock from "@theme/CodeBlock"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import type { ReactNode } from "react"

import { useSiteConfig } from "../hooks/site.ts"

import styles from "./index.module.css"

function HomepageHeader(): ReactNode {
	return (
		<header className={clsx("hero", styles.heroBanner)}>
			<div className="container">
				<p className={styles.heroEyebrow}>Open source · No API key · Runs in your process</p>
				<Heading as="h1" className={styles.heroTitle}>
					An address parser and geocoder that runs where your code runs.
				</Heading>
				<p className={styles.heroSubtitle}>
					Install it from npm, load a 39.4 MB model, and turn messy address text into labeled components and coordinates
					— with no server to call and no address leaving your infrastructure.
				</p>
				<div className={styles.heroButtons}>
					<Link className="button button--primary button--lg" to="/demo">
						Try the demo
					</Link>
				</div>
				{/* Measured, not decorative. `mailwoman geocode "1600 Pennsylvania Avenue NW, Washington, DC"`
				    returns lat 38.89767510742324, lon -77.03654697024702, resolution_tier "address_point",
				    uncertainty_m 1 — so the 4-dp rounding below is exact and "rooftop" is the house gloss for
				    an address_point hit at 1 m (mailwoman/geocode-core.ts:56: "`address_point` — rooftop /
				    parcel centroid; uncertainty_m is a small floor (~1 m)"). Re-run it before changing either
				    number. */}
				<p className={styles.heroTransform}>
					<span className={styles.heroIn}>"1600 Pennsylvania Ave NW"</span>
					<span className={styles.heroArrow}>→</span>
					<span className={styles.heroOut}>38.8977, -77.0365</span>
					<span className={styles.heroTier}>rooftop</span>
				</p>
			</div>
		</header>
	)
}

/**
 * The three-way fork. A visitor arrives wanting one of three things — to wire it up, to price it, or to see whether it
 * works at all — and each card ends in exactly one link.
 */
function Fork(): ReactNode {
	return (
		<section className={styles.gallery}>
			<div className="container">
				<Heading as="h2" className={styles.galleryHeading}>
					Where would you like to start?
				</Heading>
				<div className={clsx("row", styles.galleryRow)}>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>Build with it</p>
							<h3 className={styles.cardTitle}>Three packages and ten lines</h3>
							<p className={styles.cardBody}>
								Run <code>npm install</code>, load the English model, and parse your first address. Parsing works the
								moment the install finishes — the model travels with the package, so there is nothing to configure and
								no key to obtain.
							</p>
							<code className={styles.cardTransform}>
								"apt 4b 350 5th ave new york ny 10118" → unit·house·street·city·postcode
							</code>
							<p className={styles.cardLinks}>
								<Link to="/docs/developers/get-started/what-mailwoman-is">Start here →</Link>
							</p>
						</div>
					</div>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>What it costs</p>
							<h3 className={styles.cardTitle}>Free, or a flat license</h3>
							<p className={styles.cardBody}>
								AGPL-3.0 and free to run in production. A commercial license releases you from the source-sharing
								condition for a flat $250 a month per company. There are no seats to count and no per-address fees,
								because the software runs on your machines and reports nothing back.
							</p>
							<code className={styles.cardTransform}>2M addresses/month · $250 · 20M addresses/month · $250</code>
							<p className={styles.cardLinks}>
								<Link to="/docs/pricing">See the pricing →</Link>
							</p>
						</div>
					</div>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>See it work</p>
							<h3 className={styles.cardTitle}>The whole engine, in a browser tab</h3>
							<p className={styles.cardBody}>
								The demo is the product, not a mock of it: the same model and the same resolver, downloaded once and run
								client-side. Type an address and watch it get labeled and placed. Nothing you type is transmitted
								anywhere.
							</p>
							<code className={styles.cardTransform}>
								type an address → components, coordinate, and the source it came from
							</code>
							<p className={styles.cardLinks}>
								<Link to="/demo">Open the demo →</Link>
							</p>
						</div>
					</div>
				</div>
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
								alt="Health providers resolved across the NPPES registry, the FCC Rural Health Care funding file, and the Texas HHSC licensing list, plotted across Texas — matched on the geocoded place, with no shared key."
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
								alt="Address points across New York, each colored by its source dataset: the federal National Address Database statewide, OpenAddresses (the city's own NYC Open Data) concentrated in New York City."
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

function FeatureStrip(): ReactNode {
	return (
		<section className={styles.features}>
			<div className="container">
				<div className={clsx("row", styles.featureRow)}>
					<div className="col col--3">
						<h3>Neural address parser</h3>
						<p>
							A 6-layer encoder over a 73,143-piece SentencePiece vocabulary, quantized to int8 and executed on ONNX
							Runtime. Emits 33 BIO labels over 16 component tags — country, region, locality, postcode, street, house
							number, unit, venue and the rest — each with a confidence score.
						</p>
					</div>
					<div className="col col--3">
						<h3>Gazetteer-backed resolver</h3>
						<p>
							Parsed components resolve to <a href="https://whosonfirst.org">Who&apos;s On First</a> place IDs and
							WGS-84 coordinates over pre-indexed SQLite. Pure <code>node:sqlite</code> — no SpatiaLite, no native build
							step. The gazetteer is a 1.65 GB download you keep, not a service you call.
						</p>
					</div>
					<div className="col col--3">
						<h3>Node and the browser</h3>
						<p>
							Node 24.18 or later, and the same pipeline in a browser tab: the classifier on{" "}
							<code>onnxruntime-web</code>, the resolver on WASM SQLite over a byte-ranged gazetteer. The{" "}
							<Link to="/demo">demo</Link> is that build, not a hosted API behind a text box.
						</p>
					</div>
					<div className="col col--3">
						<h3>Drop-in and agent surfaces</h3>
						<p>
							Nominatim-, Photon- and libpostal-compatible servers answer on the shapes your client code already speaks,
							so a migration can be a hostname change. <code>@mailwoman/mcp</code> exposes parse, geocode and POI search
							to any MCP-compatible agent over stdio.
						</p>
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

export default function Home(): ReactNode {
	const { title } = useSiteConfig()

	return (
		<Layout
			title={title}
			description="An address parser and geocoder that runs in your own process. No API key, no server — a neural parser plus an open-data resolver, in Node or entirely in your browser."
		>
			<HomepageHeader />
			<main>
				<Fork />
				<FeaturedWork />
				<FeatureStrip />
				<QuickStart />
			</main>
		</Layout>
	)
}
