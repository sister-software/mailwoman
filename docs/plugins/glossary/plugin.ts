/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wrapper around `docusaurus-plugin-glossary` that keeps the package's validation, tooltip theme
 *   component (`@theme/GlossaryTerm`), client modules, and remark auto-linking — but replaces the
 *   `/glossary` route with our own page component. The upstream plugin hard-codes its route
 *   component to a path inside the package (not a `@theme/*` component), so swizzling can't reach
 *   it; overriding the lifecycle hooks is the supported seam-free alternative to vendoring.
 *
 *   On top of the upstream data model this wrapper:
 *
 *   - Requires every term to carry a non-empty `tags` array whose keys are registered in
 *     `docs/tags.yml` (build error otherwise — same spirit as the docs `onInlineTags: "throw"`).
 *   - Emits `tagMeta`: the tags.yml entries actually used by glossary terms, in declaration order,
 *     with per-tag term counts. The page renders these as filter toggles + category sections.
 *   - Emits `backlinks`: for each term, the docs pages that reference it (title + permalink),
 *     computed in `allContentLoaded` from the docs plugin's loaded content. The scan mirrors the
 *     remark auto-linker's matching rules (term + aliases, word boundaries with plural allowance,
 *     case-insensitive, proper-noun guard — see remark.ts) so the backlink list tracks the pages
 *     that actually render tooltips for the term.
 */

import path from "node:path"

import type { LoadContext, Plugin } from "@docusaurus/types"
import baseGlossaryPlugin, { GlossaryData, GlossaryPluginOptions, GlossaryTerm } from "docusaurus-plugin-glossary"
import { load as parseYAML } from "js-yaml"

/** A glossary term carrying the `tags` extension this wrapper enforces. */
export interface TaggedGlossaryTerm extends GlossaryTerm {
	tags?: string[]
}

/** One entry of the tags.yml registry, as consumed by the glossary page. */
export interface GlossaryTagMeta {
	key: string
	label: string
	description: string
	/** Number of glossary terms carrying this tag (primary or secondary). */
	count: number
}

/** A docs page that references a glossary term. */
export interface GlossaryBacklink {
	title: string
	permalink: string
}

/** Per-term backlinks, keyed by the term's `term` string. */
export interface GlossaryBacklinks {
	[term: string]: {
		refs: GlossaryBacklink[]
		total: number
	}
}

interface TagRegistryEntry {
	label?: string
	description?: string
}

/** Shape of the docs-plugin content we consume in allContentLoaded. */
interface DocsPluginContent {
	loadedVersions?: {
		docs: {
			title: string
			permalink: string
			source: string
			draft?: boolean
			unlisted?: boolean
		}[]
	}[]
}

/** Backlinks shown per term card; the rest is summarized as "+N more". */
const MAX_BACKLINKS_PER_TERM = 8

/**
 * Does `needle` occur in `text` as a whole word (with the upstream matcher's plural allowance), outside a capitalized
 * multi-word phrase? Mirrors remark.ts's guard on raw text.
 */
function referencesPhrase(text: string, textLower: string, needle: string, commonNoun: boolean): boolean {
	let searchIndex = 0

	while (searchIndex < textLower.length) {
		const index = textLower.indexOf(needle, searchIndex)

		if (index === -1) return false

		searchIndex = index + 1

		const before = index > 0 ? textLower[index - 1] : " "
		let end = index + needle.length

		// Word boundary with the upstream "s"/"es" plural allowance.
		if (/\w/.test(before)) continue

		if (end < textLower.length && /\w/.test(textLower[end])) {
			if (textLower[end] === "s" && !/\w/.test(textLower[end + 1] ?? " ")) {
				end += 1
			} else if (textLower[end] === "e" && textLower[end + 1] === "s" && !/\w/.test(textLower[end + 2] ?? " ")) {
				end += 2
			} else continue
		}

		if (commonNoun && /^[A-Z]/.test(text.slice(index, end))) {
			// Proper-noun guard: capitalized match with a capitalized neighboring word doesn't count
			// ("New York City", "United States of America").
			const beforeText = text.slice(Math.max(0, index - 40), index)
			const afterText = text.slice(end, end + 40)

			if (/(?:^|[\s([{"'–—-])[A-Z][\w'.]*\s*$/.test(beforeText) || /^\s+[A-Z]/.test(afterText)) continue
		}

		return true
	}

	return false
}

/** Strip the parts of a markdown source the remark auto-linker never links. */
function stripUnlinkableMarkdown(source: string): string {
	return source
		.replace(/^---\n[\s\S]*?\n---/, "") // frontmatter
		.replace(/```[\s\S]*?```/g, " ") // fenced code
		.replace(/`[^`\n]*`/g, " ") // inline code
		.replace(/^import\s.*$/gm, " ") // MDX imports
		.replace(/^#{1,6}\s.*$/gm, " ") // headings (skipped by the auto-linker)
}

export default function mailwomanGlossaryPlugin(context: LoadContext, options: GlossaryPluginOptions): Plugin {
	const base = baseGlossaryPlugin(context, options) as Plugin
	const { routePath = "/glossary" } = options
	const tagsPath = path.resolve(context.siteDir, "tags.yml")

	// Computed in contentLoaded, consumed in allContentLoaded (lifecycle order guarantees this).
	let glossary: GlossaryData = { terms: [] }
	let tagMeta: GlossaryTagMeta[] = []

	return {
		...base,
		// Keep the upstream name: `@theme/GlossaryTerm` reads its global data via
		// usePluginData("docusaurus-plugin-glossary"), which is keyed by plugin name.

		getPathsToWatch() {
			const basePaths = base.getPathsToWatch?.() ?? []

			return [...basePaths, tagsPath]
		},

		async contentLoaded({ content, actions }) {
			const { createData, setGlobalData } = actions

			glossary = content as GlossaryData

			const { readFile } = await import("node:fs/promises")
			const registry = parseYAML(await readFile(tagsPath, "utf8")) as Record<string, TagRegistryEntry>
			const registered = new Set(Object.keys(registry))

			const problems: string[] = []
			const counts = new Map<string, number>()

			for (const term of glossary.terms as TaggedGlossaryTerm[]) {
				if (!term.tags || term.tags.length === 0) {
					problems.push(`"${term.term}" has no tags`)
					continue
				}

				for (const tag of term.tags) {
					if (!registered.has(tag)) {
						problems.push(`"${term.term}" uses unregistered tag "${tag}"`)
						continue
					}
					counts.set(tag, (counts.get(tag) ?? 0) + 1)
				}
			}

			if (problems.length > 0) {
				throw new Error(
					`[mailwoman-glossary] Every glossary term needs tags registered in tags.yml:\n  - ${problems.join("\n  - ")}`
				)
			}

			// tags.yml declaration order is the display order for toggles and category sections.
			tagMeta = Object.entries(registry)
				.filter(([key]) => counts.has(key))
				.map(([key, entry]) => ({
					key,
					label: entry.label ?? key,
					description: entry.description ?? "",
					count: counts.get(key) ?? 0,
				}))

			// Upstream also writes this file; preserved in case a future package version reads it back.
			await createData("remark-glossary-data.json", JSON.stringify({ terms: glossary.terms ?? [], routePath }))

			// Same shape upstream publishes — the tooltip theme component reads it via usePluginData.
			setGlobalData({ terms: glossary.terms ?? [], routePath })
		},

		async allContentLoaded({ allContent, actions }) {
			const { createData, addRoute } = actions

			// Backlinks: scan every published docs page for term/alias references. Docs only — the
			// remark auto-linker is wired to the docs preset, so these are the pages that render
			// tooltips back to the glossary.
			const docsContent = allContent["docusaurus-plugin-content-docs"]?.default as DocsPluginContent | undefined
			const docs = (docsContent?.loadedVersions ?? [])
				.flatMap((version) => version.docs)
				.filter((doc) => !doc.draft && !doc.unlisted)

			const { readFile } = await import("node:fs/promises")
			const backlinks: GlossaryBacklinks = {}
			const terms = (glossary.terms ?? []) as TaggedGlossaryTerm[]

			const phrasesByTerm = terms
				.filter((term) => term.autoLink !== false)
				.map((term) => ({
					term: term.term,
					commonNoun: /^[a-z]/.test(term.term),
					phrases: [term.term, ...(term.aliases ?? [])].map((phrase) => phrase.toLowerCase()),
				}))

			for (const doc of docs) {
				const sourcePath = doc.source.replace(/^@site\//, `${context.siteDir}/`)

				let raw: string

				try {
					raw = await readFile(sourcePath, "utf8")
				} catch {
					continue
				}

				const text = stripUnlinkableMarkdown(raw)
				const textLower = text.toLowerCase()

				for (const { term, commonNoun, phrases } of phrasesByTerm) {
					if (!phrases.some((phrase) => referencesPhrase(text, textLower, phrase, commonNoun))) continue

					const entry = (backlinks[term] ??= { refs: [], total: 0 })

					entry.total += 1
					entry.refs.push({ title: doc.title, permalink: doc.permalink })
				}
			}

			for (const entry of Object.values(backlinks)) {
				entry.refs.sort((a, b) => a.title.localeCompare(b.title))
				entry.refs = entry.refs.slice(0, MAX_BACKLINKS_PER_TERM)
			}

			const glossaryDataPath = await createData("glossary-data.json", JSON.stringify(glossary))
			const tagMetaPath = await createData("glossary-tag-meta.json", JSON.stringify(tagMeta))
			const backlinksPath = await createData("glossary-backlinks.json", JSON.stringify(backlinks))

			addRoute({
				path: routePath,
				component: path.resolve(context.siteDir, "src/components/GlossaryPage/index.tsx"),
				exact: true,
				modules: {
					glossaryData: glossaryDataPath,
					tagMeta: tagMetaPath,
					backlinks: backlinksPath,
				},
			})
		},
	}
}

export type { GlossaryPluginOptions }
