/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The /glossary route component, registered by plugins/glossary/plugin.ts (which wraps
 *   docusaurus-plugin-glossary). Renders terms grouped by primary category (first tag), with
 *   toggle-button tag filters and the standard theme TOC in the right rail for jumping between
 *   categories. Term anchor ids keep the upstream scheme so remark tooltip deep-links resolve.
 */

import Link from "@docusaurus/Link"
import useBrokenLinks from "@docusaurus/useBrokenLinks"
import Layout from "@theme/Layout"
import TOC from "@theme/TOC"
import React, { useEffect, useMemo, useState } from "react"

import type { GlossaryBacklinks, GlossaryTagMeta, TaggedGlossaryTerm } from "../../../plugins/glossary/plugin.ts"

import styles from "./styles.module.css"

/** Anchor on the page h1, used by the TOC's back-to-top entry. */
const TOP_ANCHOR = "glossary"

interface GlossaryPageProps {
	glossaryData: {
		title?: string
		description?: string
		terms: TaggedGlossaryTerm[]
	}
	tagMeta: GlossaryTagMeta[]
	backlinks: GlossaryBacklinks
}

/** Upstream anchor scheme — must not change or remark tooltip links break. */
function termAnchor(term: TaggedGlossaryTerm): string {
	return term.id || term.term.toLowerCase().replace(/\s+/g, "-")
}

function relatedAnchor(related: string): string {
	return related.toLowerCase().replace(/\s+/g, "-")
}

export default function GlossaryPage({ glossaryData, tagMeta, backlinks }: GlossaryPageProps): React.JSX.Element {
	const [search, setSearch] = useState("")
	const [enabled, setEnabled] = useState<ReadonlySet<string>>(() => new Set(tagMeta.map((t) => t.key)))

	const terms = useMemo(() => glossaryData?.terms ?? [], [glossaryData])

	// Register every anchor with the SSG broken-link checker: our headings/term cards are
	// hand-rolled (not the theme Heading component), so the checker can't see their ids.
	const brokenLinks = useBrokenLinks()

	brokenLinks.collectAnchor(TOP_ANCHOR)

	for (const tag of tagMeta) {
		brokenLinks.collectAnchor(`category-${tag.key}`)
	}

	for (const term of terms) {
		brokenLinks.collectAnchor(termAnchor(term))
	}

	// Tooltip deep-links (/glossary#some-term) race the router's hash scroll against first render;
	// the target doesn't exist yet when Docusaurus tries to scroll. Re-run the jump after mount.
	useEffect(() => {
		const hash = decodeURIComponent(window.location.hash.slice(1))

		if (!hash) return
		document.getElementById(hash)?.scrollIntoView()
	}, [])

	const allEnabled = enabled.size === tagMeta.length

	const toggleTag = (key: string) => {
		setEnabled((prev) => {
			const next = new Set(prev)

			if (next.has(key)) {
				next.delete(key)
			} else {
				next.add(key)
			}

			return next
		})
	}

	const visibleTerms = useMemo(() => {
		const lowerSearch = search.trim().toLowerCase()

		return terms.filter((term) => {
			if (!term.tags?.some((tag) => enabled.has(tag))) return false

			if (!lowerSearch) return true
			const haystack = [term.term, term.definition, term.abbreviation, ...(term.aliases ?? [])]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()

			return haystack.includes(lowerSearch)
		})
	}, [terms, search, enabled])

	// Category sections in tags.yml declaration order; a term appears once, under its first
	// *enabled* tag. With everything enabled that's the primary tag; when a category is toggled
	// off, its cross-tagged terms migrate to their next enabled tag instead of stranding the
	// disabled category's section on the page.
	const sections = useMemo(() => {
		const byPrimary = new Map<string, TaggedGlossaryTerm[]>()

		for (const term of visibleTerms) {
			const primary = term.tags?.find((tag) => enabled.has(tag))

			if (!primary) continue
			const bucket = byPrimary.get(primary) ?? []
			bucket.push(term)
			byPrimary.set(primary, bucket)
		}

		return tagMeta
			.filter((tag) => byPrimary.has(tag.key))
			.map((tag) => ({
				tag,
				terms: byPrimary
					.get(tag.key)!
					.slice()
					.sort((a, b) => a.term.localeCompare(b.term)),
			}))
	}, [visibleTerms, tagMeta, enabled])

	// TOC: a back-to-top "Glossary" entry, then categories (level 2) with their visible terms
	// nested beneath (level 3). TOCItems renders `value` as HTML, so entity-escape the strings.
	const toc = useMemo(() => {
		const escapeHTML = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

		return [
			{ value: "Glossary", id: TOP_ANCHOR, level: 2 },
			...sections.flatMap(({ tag, terms: sectionTerms }) => [
				{
					value: `${escapeHTML(tag.label)} (${sectionTerms.length})`,
					id: `category-${tag.key}`,
					level: 2,
				},
				...sectionTerms.map((term) => ({
					value: escapeHTML(term.term),
					id: termAnchor(term),
					level: 3,
				})),
			]),
		]
	}, [sections])

	const title = glossaryData?.title || "Glossary"

	return (
		<Layout title={title} description={glossaryData?.description || "A glossary of terms and definitions"}>
			<div className="container margin-vert--lg">
				<div className="row">
					<main className={`col ${styles.glossaryMain}`}>
						<header className={styles.header}>
							<h1 id={TOP_ANCHOR} className={styles.pageTitle}>
								{title}
							</h1>
							{glossaryData?.description ? <p className={styles.description}>{glossaryData.description}</p> : null}
							<input
								type="search"
								placeholder="Search terms…"
								aria-label="Search glossary terms"
								className={styles.searchInput}
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<div className={styles.tagBar} role="group" aria-label="Filter by category">
								{tagMeta.map((tag) => (
									<button
										key={tag.key}
										type="button"
										className={styles.tagToggle}
										aria-pressed={enabled.has(tag.key)}
										title={tag.description}
										onClick={() => toggleTag(tag.key)}
									>
										{tag.label}
										<span className={styles.tagCount}>{tag.count}</span>
									</button>
								))}
								<button
									type="button"
									className={styles.tagBarAction}
									disabled={allEnabled}
									onClick={() => setEnabled(new Set(tagMeta.map((t) => t.key)))}
								>
									Show all
								</button>
							</div>
						</header>

						{sections.length === 0 ? (
							<div className={styles.noResults}>
								<p>
									No terms match{search.trim() ? ` "${search.trim()}"` : ""}
									{allEnabled ? "" : " within the enabled categories"}.
								</p>
							</div>
						) : (
							sections.map(({ tag, terms: sectionTerms }) => (
								<section key={tag.key} className={styles.categorySection}>
									<h2 id={`category-${tag.key}`} className={styles.categoryHeading}>
										{tag.label}
										<span className={styles.categoryCount}>{sectionTerms.length}</span>
									</h2>
									{tag.description ? <p className={styles.categoryDescription}>{tag.description}</p> : null}
									<dl className={styles.termList}>
										{sectionTerms.map((term) => (
											<div key={term.term} className={styles.termItem} id={termAnchor(term)}>
												<dt className={styles.termName}>
													{term.term}
													{term.abbreviation ? (
														<span className={styles.abbreviation}> ({term.abbreviation})</span>
													) : null}
												</dt>
												<dd className={styles.termDefinition}>
													{term.definition}
													{term.aliases?.length ? (
														<div className={styles.aliases}>Also known as: {term.aliases.join(", ")}</div>
													) : null}
													{term.relatedTerms?.length ? (
														<div className={styles.relatedTerms}>
															<strong>Related terms:</strong>{" "}
															{term.relatedTerms.map((related, index) => (
																<React.Fragment key={related}>
																	{index > 0 ? ", " : null}
																	<a href={`#${relatedAnchor(related)}`}>{related}</a>
																</React.Fragment>
															))}
														</div>
													) : null}
													{backlinks[term.term]?.refs.length ? (
														<div className={styles.backlinkList}>
															<strong>Referenced by:</strong>{" "}
															{backlinks[term.term].refs.map((ref, index) => (
																<React.Fragment key={ref.permalink}>
																	{index > 0 ? ", " : null}
																	<Link to={ref.permalink}>{ref.title}</Link>
																</React.Fragment>
															))}
															{backlinks[term.term].total > backlinks[term.term].refs.length
																? ` +${backlinks[term.term].total - backlinks[term.term].refs.length} more`
																: null}
														</div>
													) : null}
													{term.tags?.length ? (
														<div className={styles.termTags}>
															{term.tags.map((key) => {
																const tag = tagMeta.find((candidate) => candidate.key === key)

																return (
																	<button
																		key={key}
																		type="button"
																		className={styles.termTagChip}
																		title={tag ? `Show only ${tag.label}` : undefined}
																		onClick={() => setEnabled(new Set([key]))}
																	>
																		{tag?.label ?? key}
																	</button>
																)
															})}
														</div>
													) : null}
												</dd>
											</div>
										))}
									</dl>
								</section>
							))
						)}

						<footer className={styles.footer}>
							<p>
								Showing {visibleTerms.length} of {terms.length} terms
							</p>
						</footer>
					</main>
					<div className="col col--3">
						<TOC toc={toc} minHeadingLevel={2} maxHeadingLevel={3} />
					</div>
				</div>
			</div>
		</Layout>
	)
}
