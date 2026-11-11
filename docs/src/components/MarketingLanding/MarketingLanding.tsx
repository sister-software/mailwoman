import Link from "@docusaurus/Link"
import type { ReactNode } from "react"

import styles from "../../pages/marketing.module.css"

const WORKFLOWS: readonly { to: string; title: string; description: string }[] = [
	{
		to: "#inspect-an-address-entered-in-a-form",
		title: "Inspect a form entry",
		description: "Show the components and spans the parser read.",
	},
	{
		to: "#prepare-irregular-records-for-review",
		title: "Review irregular records",
		description: "Keep the original text and triage incomplete parses.",
	},
	{
		to: "#check-a-parsed-record-against-your-intake-policy",
		title: "Check an intake policy",
		description: "Apply explicit component and ZIP Code rules.",
	},
	{
		to: "#compare-candidate-duplicate-addresses",
		title: "Compare duplicate candidates",
		description: "Block and score known address pairs.",
	},
	{
		to: "#add-fields-to-a-coordinate-you-already-have",
		title: "Annotate a coordinate",
		description: "Format a coordinate and country code you already have.",
	},
]

/**
 * Introduces the parser and geocoder as separate product operations.
 */
export function ProductIntro(): ReactNode {
	return (
		<>
			<header className={styles.hero}>
				<p className={styles.eyebrow}>Product · Mailwoman 11.0.0</p>
				<h1>Read an address. Find its place.</h1>
				<p className={styles.lead}>
					Mailwoman labels address text in your application or on your server. Add local geographic data when you need
					place matches and coordinates.
				</p>
				<div className={styles.actions}>
					<Link className="button button--primary button--lg" to="/docs/start">
						Run the first parse
					</Link>
					<Link className={styles.textAction} to="/product/capabilities">
						Explore the capabilities →
					</Link>
				</div>
			</header>

			<div className={styles.cards} aria-label="Mailwoman's two operations">
				<div className={styles.card}>
					<p className={styles.cardEyebrow}>01 · Parse</p>
					<h2>Get structure from text</h2>
					<p className={styles.cardBody}>
						The published Node.js parser labels components and their spans in normalized address text. Install the model
						package to use it. The first-parse tutorial needs no geographic database.
					</p>
					<Link to="/docs/start">Inspect a published parse →</Link>
				</div>
				<div className={styles.card}>
					<p className={styles.cardEyebrow}>02 · Geocode</p>
					<h2>Resolve against local data</h2>
					<p className={styles.cardBody}>
						The geocoder uses a separate local gazetteer or supported data layer to select a place or coordinate. A
						result can include its resolution tier, candidate places, and provenance fields.
					</p>
					<Link to="/product/deployment">See deployment requirements →</Link>
				</div>
			</div>
		</>
	)
}

/**
 * Routes readers from a supported task to its executed guide and stated limits.
 */
export function SolutionsIntro(): ReactNode {
	return (
		<>
			<header className={styles.hero}>
				<p className={styles.eyebrow}>Solutions · Mailwoman 11.0.0</p>
				<h1>Choose an address workflow.</h1>
				<p className={styles.lead}>
					Start with executed guides for reading and checking address text, matching candidate records, or annotating a
					coordinate you already have. Each guide shows the input, the result, and its limits.
				</p>
				<div className={styles.actions}>
					<Link className="button button--primary button--lg" to="/docs/start">
						Run the first parse
					</Link>
					<Link className={styles.textAction} to="/product/capabilities">
						Compare the operations →
					</Link>
				</div>
			</header>

			<div className={styles.cards} aria-label="Choose a workflow">
				{WORKFLOWS.map((workflow) => (
					<Link key={workflow.to} className={styles.cardLink} to={workflow.to}>
						<strong className={styles.cardTitle}>{workflow.title}</strong>
						<span className={styles.cardCopy}>{workflow.description}</span>
						<span className={styles.cardArrow} aria-hidden="true">
							→
						</span>
					</Link>
				))}
			</div>

			<p className={styles.sectionLead}>
				These examples use published 11.0.0 packages without a geographic database. Read each guide&apos;s limits before
				using its result to make a decision.
			</p>
		</>
	)
}
