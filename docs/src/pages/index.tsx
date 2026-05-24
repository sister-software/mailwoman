import Link from "@docusaurus/Link"
import useDocusaurusContext from "@docusaurus/useDocusaurusContext"
import CodeBlock from "@theme/CodeBlock"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import type { ReactNode } from "react"

import styles from "./index.module.css"

function HomepageHeader(): ReactNode {
	const { siteConfig } = useDocusaurusContext()
	return (
		<header className={clsx("hero", styles.heroBanner)}>
			<div className="container">
				<Heading as="h1" className={styles.heroTitle}>
					{siteConfig.title}
				</Heading>
				<p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
				<div className={styles.heroButtons}>
					<Link className="button button--primary button--lg" to="/docs/plan">
						Read the plan
					</Link>
					<Link className="button button--secondary button--lg" href="https://github.com/sister-software/mailwoman">
						Source on GitHub
					</Link>
				</div>
			</div>
		</header>
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
							Mailwoman runs on Node 22+ today; the resolver + classifier are being ported to <code>sqlite-wasm</code> +{" "}
							<code>onnxruntime-web</code> so the same pipeline can run client-side without an API server.
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
				<FeatureStrip />
				<QuickStart />
			</main>
		</Layout>
	)
}
