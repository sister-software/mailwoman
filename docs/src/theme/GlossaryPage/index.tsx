import "./styles.css"
import Layout from "@theme/Layout"
import React, { useMemo, useState } from "react"

import glossaryDataRaw from "../../../glossary/glossary.json"
import { ALL_TAGS, GlossaryData, TAG_LABELS, Tag, getPresentTags, groupTermsByLetter } from "./shared.js"

import pageStyles from "./styles.module.css"

const glossaryData = glossaryDataRaw as GlossaryData

export default function GlossaryPage(): React.ReactElement {
	const [searchTerm, setSearchTerm] = useState("")
	const [activeTags, setActiveTags] = useState<Set<Tag>>(() => {
		// All tags active by default
		return new Set(ALL_TAGS)
	})

	const terms = useMemo(() => glossaryData?.terms || [], [])
	const presentTags = useMemo(() => getPresentTags(terms), [terms])

	const toggleTag = (tag: Tag) => {
		setActiveTags((prev) => {
			const next = new Set(prev)

			if (next.has(tag)) {
				next.delete(tag)
			} else {
				next.add(tag)
			}

			return next
		})
	}

	const resetTags = () => {
		setActiveTags(new Set(ALL_TAGS))
	}

	const isAllActive = activeTags.size >= ALL_TAGS.length

	const filteredTerms = useMemo(() => {
		let result = terms

		// Search filter
		if (searchTerm) {
			const lowerSearch = searchTerm.toLowerCase()
			result = result.filter((term) => {
				const haystack = [term.term, term.definition, term.abbreviation, ...(term.aliases || [])]
					.filter(Boolean)
					.join(" ")
					.toLowerCase()

				return haystack.includes(lowerSearch)
			})
		}

		// Tag filter: show term if ANY of its tags are active
		if (!isAllActive) {
			result = result.filter((term) => {
				const termTags = term.tags || []

				if (termTags.length === 0) {
					// Terms with no tags always show
					return true
				}

				return termTags.some((tag) => activeTags.has(tag as Tag))
			})
		}

		return result
	}, [terms, searchTerm, activeTags, isAllActive])

	const groupedTerms = useMemo(() => {
		return groupTermsByLetter(filteredTerms)
	}, [filteredTerms])

	const letters = Object.keys(groupedTerms).sort()

	const glossaryTitle = glossaryData?.title || "Glossary"

	return (
		<Layout title={glossaryTitle} description="A glossary of terms and definitions">
			<div className="glossaryContainer">
				<header className="glossaryHeader">
					<h1>{glossaryTitle}</h1>
					<p className="glossaryDescription">
						{glossaryData?.description || "A collection of terms and their definitions"}
					</p>

					<div className="searchContainer">
						<input
							type="text"
							placeholder="Search terms..."
							className="searchInput"
							value={searchTerm}
							onChange={(e) => setSearchTerm(e.target.value)}
						/>
					</div>
				</header>

				{/* Tag filter bar */}
				<div className={pageStyles.tagFilterBar}>
					{presentTags.map((tag) => {
						const isActive = activeTags.has(tag)
						// Count how many terms have this tag
						const count = terms.filter((t) => (t.tags || []).includes(tag)).length

						return (
							<button
								key={tag}
								type="button"
								className={`${pageStyles.tagButton} ${isActive ? pageStyles.tagButtonActive : ""}`}
								onClick={() => toggleTag(tag)}
								aria-pressed={isActive}
								title={`${TAG_LABELS[tag]} (${count} terms)`}
							>
								{TAG_LABELS[tag]}
								<span className={pageStyles.tagCount}>{count}</span>
							</button>
						)
					})}
					{!isAllActive && (
						<button type="button" className={pageStyles.tagClearAll} onClick={resetTags}>
							Reset
						</button>
					)}
				</div>

				{!isAllActive && (
					<p className={pageStyles.activeFilterCount}>
						Showing {filteredTerms.length} of {terms.length} terms ({activeTags.size} tag
						{activeTags.size !== 1 ? "s" : ""} active)
					</p>
				)}

				{filteredTerms.length === 0 ? (
					<div className="noResults">
						<p>
							No terms found
							{searchTerm ? ` matching "${searchTerm}"` : ""}
							with the selected tag filters.
						</p>
					</div>
				) : (
					<div className="glossaryContent">
						<nav className="letterNav">
							{letters.map((letter) => (
								<a key={letter} href={`#letter-${letter}`} className="letterLink">
									{letter}
								</a>
							))}
						</nav>

						{letters.map((letter) => (
							<section key={letter} id={`letter-${letter}`} className="letterSection">
								<h2 className="letterHeading">{letter}</h2>
								<dl className="termList">
									{groupedTerms[letter].map((term, index) => {
										const termId = term.id || term.term.toLowerCase().replace(/\s+/g, "-")

										return (
											<div key={`${letter}-${index}`} className="termItem" id={termId}>
												<dt className="termName">
													{term.term}
													{term.abbreviation && <span className="abbreviation"> ({term.abbreviation})</span>}
												</dt>
												<dd className="termDefinition">
													{term.definition}

													{term.relatedTerms && term.relatedTerms.length > 0 && (
														<div className="relatedTerms">
															<strong>Related terms:</strong>{" "}
															{term.relatedTerms.map((related, idx) => (
																<React.Fragment key={idx}>
																	{idx > 0 && ", "}
																	<a href={`#${related.toLowerCase().replace(/\s+/g, "-")}`}>{related}</a>
																</React.Fragment>
															))}
														</div>
													)}

													{/* Tag badges */}
													{term.tags && term.tags.length > 0 && (
														<div className={pageStyles.termTags}>
															{term.tags.map((tag) => (
																<span key={tag} className={pageStyles.termTagBadge}>
																	{TAG_LABELS[tag as Tag] || tag}
																</span>
															))}
														</div>
													)}
												</dd>
											</div>
										)
									})}
								</dl>
							</section>
						))}
					</div>
				)}

				<footer className="glossaryFooter">
					<p>Total terms: {terms.length}</p>
				</footer>
			</div>
		</Layout>
	)
}
