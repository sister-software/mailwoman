// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

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
				<h1>Label an address and find its place.</h1>
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

/**
 * Introduces the project's maintainers and directs readers to the right contact path.
 */
export function AboutIntro(): ReactNode {
	return (
		<>
			<header className={styles.hero}>
				<p className={styles.eyebrow}>About · Sister Software</p>
				<h1>Address software you can run yourself.</h1>
				<p className={styles.lead}>
					Sister Software builds Mailwoman to read postal addresses and resolve places. The parser and geocoder run in
					your application or on your server, using the model and geographic data you install.
				</p>
				<div className={styles.actions}>
					<Link className="button button--primary button--lg" to="/docs/start">
						Run the first parse
					</Link>
					<Link className={styles.textAction} to="/product">
						See how Mailwoman works →
					</Link>
				</div>
			</header>

			<div className={styles.cards} aria-label="About Mailwoman and contact routes">
				<Link className={styles.cardLink} to="/product/data-and-licensing">
					<strong className={styles.cardTitle}>Inspect the sources</strong>
					<span className={styles.cardCopy}>Read the code and data terms before choosing what to install.</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
				<Link className={styles.cardLink} to="#contact-and-support">
					<strong className={styles.cardTitle}>Ask a project question</strong>
					<span className={styles.cardCopy}>Find the contact path for licensing, support, and public issues.</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
				<Link className={styles.cardLink} to="#report-a-vulnerability-privately">
					<strong className={styles.cardTitle}>Report a vulnerability</strong>
					<span className={styles.cardCopy}>Send security details privately to the maintainer.</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
			</div>
		</>
	)
}

/**
 * Shows the scope of published benchmark evidence before readers inspect dated results.
 */
export function EvidenceIntro(): ReactNode {
	return (
		<>
			<header className={styles.hero}>
				<p className={styles.eyebrow}>Evidence · Mailwoman 11.0.0</p>
				<h1>See what the measurements cover.</h1>
				<p className={styles.lead}>
					The published evaluations measure specific models, address panels, and data vintages. The records below show
					their inputs, comparison arms, scoring methods, and limits.
				</p>
				<div className={styles.actions}>
					<Link className="button button--primary button--lg" to="#dated-artifacts">
						Inspect the evaluations
					</Link>
					<Link className={styles.textAction} to="/product/limits-and-status">
						Check release status →
					</Link>
				</div>
			</header>

			<div className={styles.cards} aria-label="Choose an evidence question">
				<Link className={styles.cardLink} to="/evidence/comparisons">
					<strong className={styles.cardTitle}>Compare geocoders</strong>
					<span className={styles.cardCopy}>
						Read the dated Mailwoman, Pelias, and Photon result beside the source limits.
					</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
				<Link className={styles.cardLink} to="#read-the-metrics-at-their-measured-scope">
					<strong className={styles.cardTitle}>Understand each metric</strong>
					<span className={styles.cardCopy}>
						Separate returned results, exact parses, coordinate distance, and throughput.
					</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
				<Link className={styles.cardLink} to="/docs/explanation/data-and-model-quality">
					<strong className={styles.cardTitle}>Follow the evaluation path</strong>
					<span className={styles.cardCopy}>
						See how a versioned dataset and release verdict support a quality claim.
					</span>
					<span className={styles.cardArrow} aria-hidden="true">
						→
					</span>
				</Link>
			</div>
		</>
	)
}
