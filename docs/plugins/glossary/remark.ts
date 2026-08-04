/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wrapper around docusaurus-plugin-glossary's remark auto-linker that removes two classes of false
 *   positive after the fact. The upstream matcher is case-insensitive with a plural allowance, so
 *   common-noun terms and aliases ("city" → locality, "state" → region) also match inside proper
 *   nouns: "New York City" tooltips "City", "United States of America" tooltips "States".
 *
 *   GUARD 1 — proper nouns. Un-links a GlossaryTerm node when all of the following hold:
 *
 *   1. The glossary term is a common noun (starts lowercase) — acronym/name terms (FST, BAN, WOF)
 *      are exempt so "admin FST" keeps its tooltip.
 *   2. The matched display text is capitalized — lowercase usage ("the city of…") keeps its tooltip.
 *   3. An adjacent word is also capitalized — the match is the interior/tail of a multi-word proper
 *      noun ("New York City", "United States of America", "State Street"). A capitalized match at a
 *      plain sentence start has no capitalized neighbor and keeps its tooltip.
 *
 *   GUARD 2 — homonyms. Un-links a node whose MATCHED SURFACE (not its term) is listed in the
 *   `noAutoLink` option. This is a surface-level suppression, so the term itself keeps its tooltip
 *   wherever it is written in full: suppressing "state" leaves "region" linking, and leaves the FST
 *   alias "finite-state transducer" linking too, even though it contains "state". See the option's
 *   comment in docusaurus.config.ts for the two false-positive classes it exists for. Surfaces are
 *   compared lowercased, with the same "s"/"es" plural allowance the upstream matcher applies, so one
 *   entry covers "State", "states" and "States".
 */

import { remarkPlugin as baseRemarkPlugin } from "docusaurus-plugin-glossary"
import type { Node, Parent } from "unist"
import { visit } from "unist-util-visit"

interface MDXJSXAttribute {
	type: string
	name: string
	value?: unknown
}

interface GlossaryTermNode extends Parent {
	type: "mdxJsxTextElement" | "mdxJsxFlowElement"
	name?: string
	attributes?: MDXJSXAttribute[]
}

interface TextNode extends Node {
	type: "text"
	value: string
}

/**
 * Does this text end with a capitalized word (plus optional trailing whitespace)?
 */
const ENDS_WITH_CAPITALIZED_WORD = /(?:^|[\s([{"'–—-])[A-Z][\w'.]*[\s]*$/
/**
 * Does this text begin with (whitespace and) a capitalized word?
 */
const STARTS_WITH_CAPITALIZED_WORD = /^\s*[A-Z]/

/**
 * Every surface an entry can be matched as, given the upstream matcher's "s"/"es" plural allowance.
 *
 * Generated FORWARD from the entry rather than un-inflected from the surface, which is the same direction the matcher
 * runs. An inverse ("strip a trailing es, else strip a trailing s") is not the inverse: it takes "states" to "stat",
 * and the first build with one shipped a guard that suppressed `state` on every page while leaving `states` linking on
 * 26.
 */
function matchableForms(entry: string): string[] {
	const lower = entry.trim().toLowerCase()

	return [lower, `${lower}s`, `${lower}es`]
}

/**
 * Is this matched surface suppressed by the homonym guard? Exported so the backlink scan in plugin.ts applies the same
 * rule against raw text — the two must agree or the glossary page lists pages that render no tooltip.
 */
export function isSuppressedSurface(display: string, noAutoLink: readonly string[]): boolean {
	if (!noAutoLink.length) return false

	const surface = display.trim().toLowerCase()

	return noAutoLink.some((entry) => matchableForms(entry).includes(surface))
}

function isGlossaryTermNode(node: Node): node is GlossaryTermNode {
	return (
		(node.type === "mdxJsxTextElement" || node.type === "mdxJsxFlowElement") &&
		(node as GlossaryTermNode).name === "GlossaryTerm"
	)
}

function attributeValue(node: GlossaryTermNode, name: string): string {
	const attr = node.attributes?.find((candidate) => candidate.name === name)

	return typeof attr?.value === "string" ? attr.value : ""
}

function applyGuards(tree: Node, noAutoLink: readonly string[]): void {
	visit(tree, isGlossaryTermNode, (node: GlossaryTermNode, index: number | undefined, parent: Parent | undefined) => {
		if (!parent || typeof index !== "number") return

		const displayChild = node.children?.[0] as TextNode | undefined
		const display = displayChild?.type === "text" ? displayChild.value : ""
		const term = attributeValue(node, "term")

		// Guard 2 runs first: it keys on the surface alone, so neither the term's casing nor the
		// neighboring words matter to it.
		if (isSuppressedSurface(display, noAutoLink)) {
			const replacement: TextNode = { type: "text", value: display }

			parent.children.splice(index, 1, replacement)

			return index + 1
		}

		if (!/^[a-z]/.test(term)) return

		if (!/^[A-Z]/.test(display)) return

		const previous = parent.children[index - 1] as TextNode | undefined
		const next = parent.children[index + 1] as TextNode | undefined
		const previousCapitalized = previous?.type === "text" && ENDS_WITH_CAPITALIZED_WORD.test(previous.value)
		const nextCapitalized = next?.type === "text" && STARTS_WITH_CAPITALIZED_WORD.test(next.value)

		if (!previousCapitalized && !nextCapitalized) return

		const replacement: TextNode = { type: "text", value: display }

		parent.children.splice(index, 1, replacement)

		return index + 1
	})
}

/**
 * Options this wrapper adds on top of the upstream remark plugin's.
 */
export interface GlossaryRemarkExtraOptions {
	/**
	 * Matched surfaces the auto-linker must never link, whatever term they belong to. See guard 2 above.
	 */
	noAutoLink?: readonly string[]
}

/**
 * Drop-in replacement for docusaurus-plugin-glossary's `remarkPlugin`: same options, same transform, followed by the
 * proper-noun and homonym guards.
 */
export default function glossaryRemarkPlugin(
	options: Parameters<typeof baseRemarkPlugin>[0] & GlossaryRemarkExtraOptions
) {
	const { noAutoLink = [], ...baseOptions } = options
	const baseTransformer = baseRemarkPlugin(baseOptions as Parameters<typeof baseRemarkPlugin>[0])

	return async (tree: Node, ...rest: unknown[]) => {
		await (baseTransformer as (tree: Node, ...rest: unknown[]) => unknown)(tree, ...rest)
		applyGuards(tree, noAutoLink)

		return tree
	}
}
