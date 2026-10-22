/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The pricing page. Three tiers, a calculator that sets the published metered rates beside the flat license, what each
 *   tier includes, and what we do and do not commit to. Every figure comes from the shop constants or `rates.ts`.
 */

import Link from "@docusaurus/Link"
import { PRICE_MONTHLY, PRICE_YEARLY, PRICE_YEARLY_PER_MONTH } from "@mailwoman/license-worker/client/constants"
import Heading from "@theme/Heading"
import Layout from "@theme/Layout"
import clsx from "clsx"
import type { ReactNode } from "react"

import { PricingCalculator } from "../components/PricingCalculator/PricingCalculator.tsx"

import styles from "./pricing.module.css"

const SALES_MAILTO = "mailto:teffen@sister.software?subject=Mailwoman%20licensing"

interface TierProps {
	name: string
	price: string
	basis: string
	audience: string
	points: readonly string[]
	cta: { label: string; to: string }
	featured?: boolean
}

const Tier = ({ name, price, basis, audience, points, cta, featured }: TierProps): ReactNode => (
	<article className={clsx(styles.tier, featured && styles.tierFeatured)}>
		<Heading as="h2" className={styles.tierName}>
			{name}
		</Heading>
		<p className={styles.tierPrice}>{price}</p>
		<p className={styles.tierBasis}>{basis}</p>
		<p className={styles.tierAudience}>{audience}</p>
		<ul className={styles.tierPoints}>
			{points.map((point) => (
				<li key={point}>{point}</li>
			))}
		</ul>
		<Link className={clsx("button", featured ? "button--primary" : "button--secondary", styles.tierCTA)} to={cta.to}>
			{cta.label}
		</Link>
	</article>
)

const INCLUDED: readonly (readonly [string, string, string, string])[] = [
	["The parser, the geocoder and the servers", "✓", "✓", "✓"],
	["The base model weights", "✓", "✓", "✓"],
	["Country weights overlays", "With a declared key", "✓", "✓"],
	["Atlas tiers beyond the base", "With a declared key", "✓", "✓"],
	["Release from the AGPL source offer", "—", "✓", "✓"],
	["OEM redistribution", "Under the AGPL", "Ask about OEM terms", "By agreement"],
	["Support", "The public tracker", "The engineers who built it", "Named contacts, agreed response time"],
	["Fine-tunes and acceptance suites", "—", "—", "Scoped with you"],
]

const DECLARATIONS: readonly (readonly [string, string, string])[] = [
	[
		"Open-source project",
		`mailwoman license declare --intent open-source --name "<project>" --project <source URL>`,
		"to the next quarter date",
	],
	["Academic", `mailwoman license declare --intent academic --organization "<university>" …`, "one year"],
	["Student", `mailwoman license declare --intent student --organization "<school>" …`, "one year"],
	["Non-profit", `mailwoman license declare --intent non-profit --organization "<name>" …`, "to the next quarter date"],
	["Evaluation", `mailwoman license evaluate --name "<team>" --email <address>`, "thirty days, once"],
]

export default function Pricing(): ReactNode {
	return (
		<Layout
			title="Pricing"
			description={`Free under the AGPL, or ${PRICE_MONTHLY} a month for a commercial license. No per-address fees at any volume.`}
		>
			<header className={styles.hero}>
				<div className="container">
					<p className={styles.eyebrow}>Pricing</p>
					<Heading as="h1" className={styles.heroTitle}>
						Geocoding without a meter.
					</Heading>
					<p className={styles.heroLead}>
						Mailwoman runs on your machines, so we have nothing to count. Use it free under the AGPL, or pay one flat
						price to keep your own source closed. Your thousandth lookup and your hundred-millionth cost the same.
					</p>
				</div>
			</header>

			<main>
				<section className={clsx("container", styles.tiers)}>
					<Tier
						name="Open source"
						price="Free"
						basis="AGPL-3.0, forever"
						audience="Open-source projects, research, teaching, non-profits, evaluations."
						points={[
							"The parser, the geocoder and the drop-in servers",
							"The base model weights",
							"Paid tiers with a declared key",
							"Share your source with the people you serve",
						]}
						cta={{ label: "Get started", to: "/docs/developers/get-started/what-mailwoman-is" }}
					/>
					<Tier
						featured
						name="Commercial"
						price={PRICE_MONTHLY}
						basis={`a month, or ${PRICE_YEARLY} a year (${PRICE_YEARLY_PER_MONTH} a month). Per company.`}
						audience="Companies under 250 employees and $10M in annual revenue."
						points={[
							"Keep your product closed source",
							"Every developer, environment and product",
							"Every country overlay and atlas tier",
							"A direct line to the engineers who built it",
						]}
						cta={{ label: "Buy a license", to: "/license#purchase-a-license" }}
					/>
					<Tier
						name="Enterprise"
						price="Let's talk"
						basis="Scoped with you, billed yearly"
						audience="Larger companies, OEM, and address data unlike any public corpus."
						points={[
							"The commercial license at any company size",
							"A model fine-tuned on your addresses",
							"An acceptance suite built from your data",
							"Named contacts and an agreed response time",
						]}
						cta={{ label: "Contact us", to: SALES_MAILTO }}
					/>
				</section>

				<section className={clsx("container", styles.section)}>
					<Heading as="h2" className={styles.sectionTitle}>
						Move the slider. Watch which row moves.
					</Heading>
					<p className={styles.sectionLead}>
						Metered geocoders price each lookup, so the bill follows your address volume. Ours follows nothing.
					</p>
					<PricingCalculator />
				</section>

				<section className={clsx("container", styles.section)}>
					<Heading as="h2" className={styles.sectionTitle}>
						What each tier includes
					</Heading>
					<div className={styles.tableWrap}>
						<table className={styles.compare}>
							<thead>
								<tr>
									<th scope="col">
										<span className="sr-only">Feature</span>
									</th>
									<th scope="col">Open source</th>
									<th scope="col">Commercial</th>
									<th scope="col">Enterprise</th>
								</tr>
							</thead>
							<tbody>
								{INCLUDED.map(([feature, ...cells]) => (
									<tr key={feature}>
										<th scope="row">{feature}</th>
										{cells.map((cell, index) => (
											<td key={index} className={cell === "✓" || cell === "—" ? styles.mark : undefined}>
												{cell === "✓" ? <span aria-label="Included">✓</span> : null}
												{cell === "—" ? <span aria-label="Not included">—</span> : null}
												{cell !== "✓" && cell !== "—" ? cell : null}
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className={styles.fine}>All prices are in US dollars and exclude VAT and sales taxes.</p>
				</section>

				<section className={clsx("container", styles.section, styles.split)}>
					<div>
						<Heading as="h2" className={styles.sectionTitle}>
							Free keys for open work
						</Heading>
						<p>
							A declared key admits the paid tiers without changing the terms: the AGPL still applies, and the notice
							says so. Each route is one command. The{" "}
							<Link to="/docs/solutions/research-and-teaching">research and teaching</Link> page covers the academic
							routes and how to cite Mailwoman.
						</p>
					</div>
					<dl className={styles.declarations}>
						{DECLARATIONS.map(([intent, command, lasts]) => (
							<div key={intent}>
								<dt>
									{intent} <span className={styles.lasts}>· {lasts}</span>
								</dt>
								<dd>
									<code>{command}</code>
								</dd>
							</div>
						))}
					</dl>
				</section>

				<section className={clsx("container", styles.section, styles.promises)}>
					<div>
						<Heading as="h2" className={styles.sectionTitle}>
							What we commit to
						</Heading>
						<dl>
							<dt>Your rate is fixed at signup.</dt>
							<dd>A later price rise applies to new subscriptions. Yours stays where it started while it is active.</dd>
							<dt>Published releases stay published.</dt>
							<dd>Every AGPL release already shipped is yours permanently. We could not withdraw that grant.</dd>
							<dt>We do not count your lookups.</dt>
							<dd>
								There is no usage to true up at renewal.{" "}
								<Link to="/docs/solutions/eliminate-the-per-request-bill">Eliminate the per-request bill</Link> works
								the arithmetic.
							</dd>
							<dt>A key never changes what runs.</dt>
							<dd>An artifact already on disk keeps working after its key expires.</dd>
						</dl>
					</div>
					<div>
						<Heading as="h2" className={styles.sectionTitle}>
							What we do not commit to
						</Heading>
						<dl>
							<dt>A data refresh cadence.</dt>
							<dd>
								The gazetteer is rebuilt when coverage changes or an ingest bug is fixed. Each artifact is sealed and
								dated, so you can tell which vintage you run.
							</dd>
							<dt>A license for the data.</dt>
							<dd>
								Ours covers the code. The reference data comes from open sources with their own terms. Read{" "}
								<Link to="/docs/about/security-and-compliance">Security and compliance</Link> before you ship.
							</dd>
						</dl>
					</div>
				</section>

				<section className={styles.closing}>
					<div className="container">
						<Heading as="h2" className={styles.closingTitle}>
							Try it before anyone signs anything.
						</Heading>
						<p>Geocode an address in your browser, or install it and parse one in ten minutes.</p>
						<div className={styles.closingButtons}>
							<Link className="button button--primary button--lg" href="https://earth.mailwoman.ai/">
								Try the geocoder
							</Link>
							<Link className="button button--secondary button--lg" to="/docs/developers/get-started/ten-minute-trial">
								Your first ten minutes
							</Link>
						</div>
						<p className={styles.fine}>
							OEM, redistribution, or a negotiated agreement: <a href={SALES_MAILTO}>email us about a license</a>.
						</p>
					</div>
				</section>
			</main>
		</Layout>
	)
}
