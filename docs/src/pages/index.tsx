import Link from "@docusaurus/Link"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import CodeBlock from "@theme/CodeBlock"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./index.module.css"

function HomepageHeader(): ReactNode {
	return (
		<header className={clsx("hero", styles.heroBanner)}>
			<div className="container">
				<p className={styles.heroEyebrow}>Open source · No API key · Runs in your browser</p>
				<Heading as="h1" className={styles.heroTitle}>
					Still assembling a geocoder from spare parts?
				</Heading>
				<p className={styles.heroSubtitle}>
					Mailwoman parses, geocodes, and resolves messy records to real places — so you can stop stitching tools
					together and get back to the problem you set out to solve.
				</p>
				<div className={styles.heroButtons}>
					<Link className="button button--primary button--lg" to="/demo">
						Try the demo
					</Link>
					<Link className="button button--secondary button--lg" to="/docs/getting-started">
						Read the docs
					</Link>
				</div>
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

function Gallery(): ReactNode {
	return (
		<section className={styles.gallery}>
			<div className="container">
				<Heading as="h2" className={styles.galleryHeading}>
					What you'd build with it
				</Heading>
				<p className={styles.gallerySub}>
					Recognizable jobs you've lost a week to, done without the assembly tax — and every one runs on open data you
					can audit.
				</p>
				<div className={clsx("row", styles.galleryRow)}>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>Parse</p>
							<h3 className={styles.cardTitle}>Untangle any address line</h3>
							<p className={styles.cardBody}>
								Paste a gnarly, half-formatted, mistyped address and watch the neural parser label every component —
								house number, street, unit, city, postcode — across locales, live in the page.
							</p>
							<code className={styles.cardTransform}>
								"Apt 4, 12 Rue de Rivoli, 75001 Paris" → unit·house·street·postcode·city
							</code>
							<p className={styles.cardLinks}>
								<Link to="/demo">Open the playground →</Link>
							</p>
						</div>
					</div>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>Geocode</p>
							<h3 className={styles.cardTitle}>Geocode on-device</h3>
							<p className={styles.cardBody}>
								Resolve an address to a real coordinate with no server, no API key, and no query leaving the machine. A
								29.8 MB model and a byte-ranged global gazetteer do it in the tab.
							</p>
							<code className={styles.cardTransform}>"350 5th Ave, New York" → 40.7484, -73.9857 · rooftop</code>
							<p className={styles.cardLinks}>
								<Link to="/demo">Try the demo</Link> ·{" "}
								<Link to="/research/geocoding-that-never-phones-home">Read the story →</Link>
							</p>
						</div>
					</div>
					<div className="col col--4">
						<div className={styles.galleryCard}>
							<p className={styles.cardJob}>Match</p>
							<h3 className={styles.cardTitle}>Match records by place, not spelling</h3>
							<p className={styles.cardBody}>
								Resolve fragmented records with no shared key into entities. Block on the geocoded place, then match on
								canonicalized names, with a calibrated score and an abstain band for review.
							</p>
							<code className={styles.cardTransform}>123 Main St + 123 Main Street Apt 2 → 1 entity</code>
							<p className={styles.cardLinks}>
								<Link to="/research/same-building-different-company">Read the story →</Link>
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
					<div className="col col--4">
						<h3>Neural address parser</h3>
						<p>
							ONNX-runtime sequence classifier over a SentencePiece tokenizer. Emits BIO-labeled components (country /
							region / locality / postcode / street / venue / …). Trained on a corpus stitched from TIGER, NAD, BAN,
							OpenAddresses + curated rows. Ships per-locale weight bundles as separate npm packages.
						</p>
					</div>
					<div className="col col--4">
						<h3>WOF-backed resolver</h3>
						<p>
							Parsed components are resolved to <a href="https://whosonfirst.org">Who&apos;s On First</a> place IDs +
							WGS-84 coordinates via FTS5 + R*Tree over pre-indexed SQLite shards. Pure <code>node:sqlite</code>, no
							SpatiaLite, no native build deps. Multi-shard ATTACH routes postcode queries to the postalcode shard
							automatically.
						</p>
					</div>
					<div className="col col--4">
						<h3>Pure-TypeScript runtime</h3>
						<p>
							Mailwoman runs on Node 22+ and, as the <Link to="/demo">live demo</Link> shows, entirely in the browser —
							the classifier on <code>onnxruntime-web</code>, the resolver on <code>sql.js-httpvfs</code> over a
							byte-ranged gazetteer. The same pipeline client-side, no API server.
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
						<CodeBlock language="ts">
							{`import { NeuralAddressClassifier } from "@mailwoman/neural"

const neural = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const components = await neural.parseJson("1600 Pennsylvania Ave NW, Washington DC")
// → { house_number: "1600", street: "Pennsylvania Ave NW", locality: "Washington", region: "DC" }`}
						</CodeBlock>
					</div>
					<div className="col col--6">
						<h4>CLI</h4>
						<CodeBlock language="bash">{`# parse + resolve in one shot
MAILWOMAN_WOF_DB=/path/to/wof.db npx mailwoman parse \\
  --neural --resolve --format xml \\
  "Springfield, Illinois"`}</CodeBlock>
						<CodeBlock language="xml">
							{`<address raw="Springfield, Illinois">
  <region src="resolver:region:85688697" lat="40.27" lon="-89.19">Illinois
    <locality src="resolver:locality:85940429"
              lat="39.80" lon="-89.65"
              place="wof:85940429">Springfield</locality>
  </region>
</address>`}
						</CodeBlock>
					</div>
				</div>
			</div>
		</section>
	)
}

export default function Home(): ReactNode {
	const { siteConfig } = useDocusaurusContext()
	return (
		<Layout
			title={siteConfig.title}
			description="TypeScript-first address parser + geocoder. Neural classifier + WOF resolver, runs in Node and the browser."
		>
			<HomepageHeader />
			<main>
				<Gallery />
				<FeaturedWork />
				<FeatureStrip />
				<QuickStart />
			</main>
		</Layout>
	)
}
