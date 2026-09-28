/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   US region recognition: a rule-based parse-tree correction for the case the neural parser
 *   under-handles, a postcode-less "City, State" string. Without a postcode or street anchor the
 *   model mistags the state. It labels "Texas" a `locality` ("Dublin, Texas" becomes two
 *   localities), or merges the whole string into one locality ("Dublin, TX" or "Athens, Texas").
 *   With no `region` node, the resolver cannot scope the locality to its state.
 *
 *   This is a legitimate atlas correction: the US states are a closed known gazetteer, so a state
 *   token the grammar missed can be retagged confidently. The module restructures the affected
 *   nodes into `region → locality` nesting, which the resolver's existing parent-scoping then
 *   constrains correctly without a resolver change. Two shapes are handled:
 *
 *   - A `locality` whose whole value is a US state becomes a `region`, and sibling locality
 *     (city) nodes are nested under it.
 *   - A `locality` whose value is a merged `"City, ST"` is split into `region(ST) → locality(City)`.
 *
 *   US-scoped by design, since the gazetteer is US states. The long-term fix is the model
 *   recognizing the region, and this closes the gap for the bare `City, State` class.
 */

import type { ComponentTag } from "@mailwoman/codex/component"
import type { AddressNode, AddressTree } from "@mailwoman/core/decoder"
import { walkNodes } from "@mailwoman/core/decoder"

/**
 * Canonical 2-letter slug for a US state/territory name or 2-letter abbreviation, else null.
 */
const STATE_NAME_TO_SLUG: Record<string, string> = {
	alabama: "al",
	alaska: "ak",
	arizona: "az",
	arkansas: "ar",
	california: "ca",
	colorado: "co",
	connecticut: "ct",
	delaware: "de",
	"district of columbia": "dc",
	florida: "fl",
	georgia: "ga",
	hawaii: "hi",
	idaho: "id",
	illinois: "il",
	indiana: "in",
	iowa: "ia",
	kansas: "ks",
	kentucky: "ky",
	louisiana: "la",
	maine: "me",
	maryland: "md",
	massachusetts: "ma",
	michigan: "mi",
	minnesota: "mn",
	mississippi: "ms",
	missouri: "mo",
	montana: "mt",
	nebraska: "ne",
	nevada: "nv",
	"new hampshire": "nh",
	"new jersey": "nj",
	"new mexico": "nm",
	"new york": "ny",
	"north carolina": "nc",
	"north dakota": "nd",
	ohio: "oh",
	oklahoma: "ok",
	oregon: "or",
	pennsylvania: "pa",
	"rhode island": "ri",
	"south carolina": "sc",
	"south dakota": "sd",
	tennessee: "tn",
	texas: "tx",
	utah: "ut",
	vermont: "vt",
	virginia: "va",
	washington: "wa",
	"west virginia": "wv",
	wisconsin: "wi",
	wyoming: "wy",
	"puerto rico": "pr",
}

const STATE_SLUGS = new Set(Object.values(STATE_NAME_TO_SLUG))

/**
 * Is `value` exactly a US state, its full name (e.g. "Texas") or 2-letter abbreviation
 * (e.g. "TX")?
 *
 * @returns The canonical 2-letter slug, else null.
 * Whitespace and case insensitive.
 * Rejects anything with extra tokens, so a city that shares a state's name is only matched when
 * it is the whole value.
 */
export function usStateSlug(value: string): string | null {
	const v = value.trim().toLowerCase()

	if (!v) return null

	if (STATE_NAME_TO_SLUG[v]) return STATE_NAME_TO_SLUG[v]!

	if (/^[a-z]{2}$/.test(v) && STATE_SLUGS.has(v)) return v

	return null
}

/**
 * Build a region node covering the state token, carrying a (lightly-confident) provenance marker.
 */
function makeRegionNode(value: string, start: number, end: number, confidence: number): AddressNode {
	return {
		tag: "region" as ComponentTag,
		value,
		start,
		end,
		confidence,
		children: [],
		metadata: { region_recognition: "us-state" },
	}
}

/**
 * Correct one container (an array of sibling nodes: the tree roots, or a node's children) for the
 * two mistag shapes, producing `region → locality` nesting.
 *
 * @returns The rewritten sibling list.
 */
function correctSiblings(siblings: AddressNode[]): AddressNode[] {
	const afterSplit: AddressNode[] = []

	for (const node of siblings) {
		const split = node.tag === "locality" ? splitMergedCityState(node) : null
		afterSplit.push(split ?? node)
	}

	// Turn a locality whose whole value is a state into a region, with sibling city localities nested
	// under it. This fires only when exactly one state-name locality is in the container, the
	// unambiguous "City, State" shape, so a multi-locality list is not reparented.
	const stateIdxs = afterSplit
		.map((n, i) => (n.tag === "locality" && usStateSlug(n.value) ? i : -1))
		.filter((i) => i >= 0)

	if (stateIdxs.length !== 1) return afterSplit
	const si = stateIdxs[0]!
	const stateNode = afterSplit[si]!
	const region = makeRegionNode(stateNode.value, stateNode.start, stateNode.end, stateNode.confidence)
	const out: AddressNode[] = []

	for (let i = 0; i < afterSplit.length; i++) {
		if (i === si) continue
		const n = afterSplit[i]!

		if (n.tag === "locality") {
			region.children.push(n)
		}
		else {
			out.push(n)
		}
	}

	// Only convert when there is a sibling city to nest, the unambiguous "City, State" shape. A lone
	// state-name locality ("Washington", "Florida") is genuinely a city in this context as often as a
	// state, so leave it untouched rather than risk a mis-fire.
	if (!region.children.length) return afterSplit
	out.push(region)

	return out
}

/**
 * Split a `locality` whose value is `"City, ST"` (state in the last comma segment)
 * into region(ST) → locality(City).
 *
 * @returns Null when the tail isn't a US state.
 */
function splitMergedCityState(node: AddressNode): AddressNode | null {
	const comma = node.value.lastIndexOf(",")

	if (comma === -1) return null
	const head = node.value.slice(0, comma).trim()
	const tail = node.value.slice(comma + 1).trim()
	const slug = usStateSlug(tail)

	if (!slug || !head) return null
	// Offsets: the region covers the tail's char span, and the locality covers the head's span
	// relative to node.start.
	const tailStart = node.start + node.value.indexOf(tail, comma)
	const region = makeRegionNode(tail, tailStart, node.end, node.confidence)

	region.children.push({
		tag: "locality" as ComponentTag,
		value: head,
		start: node.start,
		end: node.start + head.length,
		confidence: node.confidence,
		children: node.children,
		...(node.metadata ? { metadata: node.metadata } : {}),
	})

	return region
}

/**
 * Recursively correct a node's children.
 */
function correctNode(node: AddressNode): AddressNode {
	if (node.children.length) {
		node.children = correctSiblings(node.children).map(correctNode)
	}

	return node
}

/**
 * Stamp `country_hint: "US"` on a region node whose value is a 2-letter US state abbreviation,
 * both the ones the parser produced directly ("Augusta, ME" becomes region(ME)) and the ones this
 * module retagged.
 *
 * This is the forward address-system to country linkage: the resolver constrains a hinted region's
 * lookup to US, so a two-consistent-pairs collision ("Augusta" under both Maine and Messina)
 * resolves the US state.
 *
 * Abbreviations only, deliberately. A 2-letter "ME", "or" or "GA" in `City, ST` position is
 * unambiguously the US state (foreign collisions like Messina or Ourense lose in US-format
 * context, and Georgia-the-country is "GE").
 *
 * A full name is genuinely ambiguous ("Tbilisi, Georgia" is the country, "Atlanta, Georgia" the
 * state), so full-name tokens are left to resolve on their own name-match evidence and are never pinned.
 */
function annotateUSRegions(roots: readonly AddressNode[]): void {
	for (const node of walkNodes(roots)) {
		if (node.tag === "region" && /^[A-Za-z]{2}$/.test(node.value.trim()) && usStateSlug(node.value)) {
			node.metadata = { ...node.metadata, country_hint: "US" }
		}
	}
}

/**
 * Recognize US regions the parser missed and restructure `"City, State"` into
 * `region → locality` nesting so the resolver scopes the locality to its state.
 *
 * Mutates and returns the tree. It is a no-op when no US state token is found mistagged, so it is
 * byte-stable for already-correct parses.
 */
export function recognizeUSRegions(tree: AddressTree): AddressTree {
	tree.roots = correctSiblings(tree.roots).map(correctNode)

	annotateUSRegions(tree.roots)

	return tree
}
