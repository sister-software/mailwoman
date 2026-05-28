/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   In-memory FST matcher. Built by `fst-builder.ts`, queried at runtime for emission priors and CLI
 *   introspection. The structure is a deterministic trie over normalized tokens with PlaceEntry
 *   arrays at accepting states.
 */

import type { FstContinuation, FstMatchResult, FstQueryResult, PlaceEntry } from "./fst-types.js"

interface FstNode {
	edges: Map<string, number>
	places: PlaceEntry[]
}

export class FstMatcher {
	private nodes: FstNode[]

	constructor(nodes: FstNode[]) {
		this.nodes = nodes
	}

	get stateCount(): number {
		return this.nodes.length
	}

	get placeCount(): number {
		let count = 0
		for (const n of this.nodes) count += n.places.length
		return count
	}

	walk(tokens: string[]): FstMatchResult | null {
		let stateId = 0
		for (let i = 0; i < tokens.length; i++) {
			const node = this.nodes[stateId]
			if (!node) return null
			const next = node.edges.get(tokens[i]!)
			if (next === undefined) return null
			stateId = next
		}
		const node = this.nodes[stateId]!
		return { stateId, accepted: node.places.length > 0, depth: tokens.length }
	}

	walkFrom(prev: FstMatchResult, token: string): FstMatchResult | null {
		const node = this.nodes[prev.stateId]
		if (!node) return null
		const next = node.edges.get(token)
		if (next === undefined) return null
		const target = this.nodes[next]!
		return { stateId: next, accepted: target.places.length > 0, depth: prev.depth + 1 }
	}

	accepting(stateId: number): PlaceEntry[] {
		return this.nodes[stateId]?.places ?? []
	}

	continuations(stateId: number): FstContinuation[] {
		const node = this.nodes[stateId]
		if (!node) return []
		const result: FstContinuation[] = []
		for (const [token, targetId] of node.edges) {
			const target = this.nodes[targetId]!
			result.push({
				token,
				targetState: targetId,
				acceptingCount: target.places.length,
			})
		}
		return result
	}

	query(text: string): FstQueryResult {
		const tokens = normalizeTokens(text)
		const match = this.walk(tokens)
		if (!match) {
			// Walk as far as possible to find where we fall off
			let stateId = 0
			let depth = 0
			for (const t of tokens) {
				const node = this.nodes[stateId]
				if (!node) break
				const next = node.edges.get(t)
				if (next === undefined) break
				stateId = next
				depth++
			}
			return {
				path: tokens.slice(0, depth),
				stateId,
				accepting: this.accepting(stateId),
				continuations: this.continuations(stateId),
			}
		}
		return {
			path: tokens,
			stateId: match.stateId,
			accepting: this.accepting(match.stateId),
			continuations: this.continuations(match.stateId),
		}
	}

	get nodeCount(): number {
		return this.nodes.length
	}

	/** Expose the internal node array for serialization. */
	toNodes(): readonly FstNode[] {
		return this.nodes
	}

	static fromNodes(nodes: FstNode[]): FstMatcher {
		return new FstMatcher(nodes)
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

export type { FstNode }
