/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory FST matcher. Built by `fst-builder.ts`, queried at runtime for emission priors and CLI
 *   introspection. The structure is a deterministic trie over normalized tokens with PlaceEntry
 *   arrays at accepting states.
 */

import type { FSTContinuation, FSTMatchResult, FSTQueryResult, PlaceEntry } from "./fst-types.js"

interface FSTNode {
	edges: Map<string, number>
	places: PlaceEntry[]
}

export class FSTMatcher {
	private nodes: FSTNode[]

	constructor(nodes: FSTNode[]) {
		this.nodes = nodes
	}

	get stateCount(): number {
		return this.nodes.length
	}

	get placeCount(): number {
		let count = 0

		for (const n of this.nodes) {
			count += n.places.length
		}

		return count
	}

	walk(tokens: string[]): FSTMatchResult | null {
		let stateID = 0

		for (let i = 0; i < tokens.length; i++) {
			const node = this.nodes[stateID]

			if (!node) return null
			const next = node.edges.get(tokens[i]!)

			if (next === undefined) return null
			stateID = next
		}
		const node = this.nodes[stateID]!

		return { stateID, accepted: node.places.length > 0, depth: tokens.length }
	}

	walkFrom(prev: FSTMatchResult, token: string): FSTMatchResult | null {
		const node = this.nodes[prev.stateID]

		if (!node) return null
		const next = node.edges.get(token)

		if (next === undefined) return null
		const target = this.nodes[next]!

		return { stateID: next, accepted: target.places.length > 0, depth: prev.depth + 1 }
	}

	accepting(stateID: number): PlaceEntry[] {
		return this.nodes[stateID]?.places ?? []
	}

	continuations(stateID: number): FSTContinuation[] {
		const node = this.nodes[stateID]

		if (!node) return []
		const result: FSTContinuation[] = []

		for (const [token, targetID] of node.edges) {
			const target = this.nodes[targetID]!
			result.push({
				token,
				targetState: targetID,
				acceptingCount: target.places.length,
			})
		}

		return result
	}

	query(text: string): FSTQueryResult {
		const tokens = normalizeTokens(text)
		const match = this.walk(tokens)

		if (!match) {
			// Walk as far as possible to find where we fall off
			let stateID = 0
			let depth = 0

			for (const t of tokens) {
				const node = this.nodes[stateID]

				if (!node) break
				const next = node.edges.get(t)

				if (next === undefined) break
				stateID = next
				depth++
			}

			return {
				path: tokens.slice(0, depth),
				stateID,
				accepting: this.accepting(stateID),
				continuations: this.continuations(stateID),
			}
		}

		return {
			path: tokens,
			stateID: match.stateID,
			accepting: this.accepting(match.stateID),
			continuations: this.continuations(match.stateID),
		}
	}

	get nodeCount(): number {
		return this.nodes.length
	}

	/** Expose the internal node array for serialization. */
	toNodes(): readonly FSTNode[] {
		return this.nodes
	}

	static fromNodes(nodes: FSTNode[]): FSTMatcher {
		return new FSTMatcher(nodes)
	}
}

/** Normalize text into FST tokens: lowercase, NFKC, strip punctuation, split on whitespace. */
export function normalizeTokens(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\p{P}\p{S}]/gu, "")
		.split(/\s+/)
		.filter((t) => t.length > 0)
}

export type { FSTNode }
