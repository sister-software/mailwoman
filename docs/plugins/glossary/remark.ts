/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Wrapper around docusaurus-plugin-glossary's remark auto-linker that removes proper-noun false
 *   positives after the fact. The upstream matcher is case-insensitive with a plural allowance, so
 *   common-noun terms and aliases ("city" → locality, "state" → region) also match inside proper
 *   nouns: "New York City" tooltips "City", "United States of America" tooltips "States".
 *
 *   The guard un-links a GlossaryTerm node when all of the following hold:
 *
 *   1. The glossary term is a common noun (starts lowercase) — acronym/name terms (FST, BAN, WOF)
 *      are exempt so "admin FST" keeps its tooltip.
 *   2. The matched display text is capitalized — lowercase usage ("the city of…") keeps its tooltip.
 *   3. An adjacent word is also capitalized — the match is the interior/tail of a multi-word proper
 *      noun ("New York City", "United States of America", "State Street"). A capitalized match at a
 *      plain sentence start has no capitalized neighbor and keeps its tooltip.
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

/** Does this text end with a capitalized word (plus optional trailing whitespace)? */
const ENDS_WITH_CAPITALIZED_WORD = /(?:^|[\s([{"'–—-])[A-Z][\w'.]*[\s]*$/
/** Does this text begin with (whitespace and) a capitalized word? */
const STARTS_WITH_CAPITALIZED_WORD = /^\s*[A-Z]/

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

function applyProperNounGuard(tree: Node): void {
	visit(tree, isGlossaryTermNode, (node: GlossaryTermNode, index: number | undefined, parent: Parent | undefined) => {
		if (!parent || typeof index !== "number") return

		const displayChild = node.children?.[0] as TextNode | undefined
		const display = displayChild?.type === "text" ? displayChild.value : ""
		const term = attributeValue(node, "term")

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
 * Drop-in replacement for docusaurus-plugin-glossary's `remarkPlugin`: same options, same transform, followed by the
 * proper-noun guard.
 */
export default function glossaryRemarkPlugin(options: Parameters<typeof baseRemarkPlugin>[0]) {
	const baseTransformer = baseRemarkPlugin(options)

	return async (tree: Node, ...rest: unknown[]) => {
		await (baseTransformer as (tree: Node, ...rest: unknown[]) => unknown)(tree, ...rest)
		applyProperNounGuard(tree)

		return tree
	}
}
