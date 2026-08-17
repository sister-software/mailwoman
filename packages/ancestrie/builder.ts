/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Build side of the ancestrie: accumulate entries into a token trie, then seal — compute pre/post
 *   interval labels over the primary-parent forest and serialize to the versioned binary described
 *   in `format.ts`. The output is canonical: sealing the same entry set yields identical bytes
 *   regardless of add order (see the CANONICAL OUTPUT note in the format doc), so artifact diffs
 *   mean data changed, never that a build iterated differently.
 *
 *   No Node imports — the builder runs anywhere the reader does. Serialization is a build-time
 *   operation all the same; the reader (`reader.ts`) is the runtime surface.
 */

import type { AncestrieHeader } from "./format.ts"
import {
	ANCESTRIE_FORMAT_VERSION,
	computeSections,
	EDGE_ENTRY_SIZE,
	ENTRY_FLAG_HAS_PAYLOAD,
	ENTRY_FLAG_PAYLOAD_JSON,
	ENTRY_RECORD_SIZE,
	ENTRY_REF_SIZE,
	ID_INDEX_ENTRY_SIZE,
	STATE_ENTRY_SIZE,
	writeHeader,
} from "./format.ts"
import type { AncestrieBuilderOptions, AncestrieEntry, JSONValue, SealOptions, TokenNormalizer } from "./types.ts"

/**
 * Upper bound for ids, parent ids, and every table index — the format stores them as u32.
 */
const U32_MAX = 0xff_ff_ff_ff

/**
 * Upper bound for an entry's parent count — the format stores it as u16.
 */
const U16_MAX = 0xff_ff

const UTF8_ENCODER = new TextEncoder()

interface TrieNode {
	edges: Map<string, TrieNode>
	entryIDs: number[]
}

interface EntryMeta {
	rank: number
	parentIDs: number[]
	payload?: { bytes: Uint8Array; isJSON: boolean }
}

/**
 * A trie state after canonical renumbering: edges as (token, canonical target index) pairs in sorted-token order, entry
 * ids sorted ascending.
 */
interface CanonicalState {
	edges: Array<[token: string, target: number]>
	entryIDs: number[]
}

/**
 * The interval forest labels: pre/post per entry id, plus the pre-order entry sequence (`ordinals`) and its inverse.
 */
interface IntervalForest {
	preOf: Map<number, number>
	postOf: Map<number, number>
	ordinals: number[]
	ordinalOf: Map<number, number>
}

function assertU32(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
		throw new TypeError(`${label} must be an integer in [0, 2^32), got ${value}`)
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}

	return true
}

function encodePayload(payload: Uint8Array | JSONValue | undefined): EntryMeta["payload"] {
	if (payload === undefined) return undefined

	if (payload instanceof Uint8Array) {
		// Copied so a caller mutating its buffer after `add` cannot change what seals.
		return { bytes: new Uint8Array(payload), isJSON: false }
	}

	const json = JSON.stringify(payload)

	if (json === undefined) {
		throw new TypeError("payload must be a Uint8Array or JSON-serializable")
	}

	return { bytes: UTF8_ENCODER.encode(json), isJSON: true }
}

/**
 * Renumber the trie canonically: a pre-order DFS that visits edges in sorted-token order assigns every state its index
 * (root = 0), independent of add order.
 */
function canonicalizeTrie(root: TrieNode): CanonicalState[] {
	const indexOfNode = new Map<TrieNode, number>()
	const order: TrieNode[] = []
	const stack: TrieNode[] = [root]

	while (stack.length) {
		const node = stack.pop()!
		indexOfNode.set(node, order.length)
		order.push(node)
		const sortedTokens = [...node.edges.keys()].toSorted()

		// Pushed in reverse so the pop order — and therefore the numbering — follows sorted-token order.
		for (let i = sortedTokens.length - 1; i >= 0; i--) {
			stack.push(node.edges.get(sortedTokens[i]!)!)
		}
	}

	return order.map((node) => {
		return {
			edges: [...node.edges.keys()].toSorted().map((token): [string, number] => {
				return [token, indexOfNode.get(node.edges.get(token)!)!]
			}),
			entryIDs: node.entryIDs.toSorted((a, b) => a - b),
		}
	})
}

/**
 * Label the primary-parent forest with pre/post intervals from a single counter, visiting roots and sibling lists in
 * ascending-id order. Throws on a primary-parent cycle — an entry a root cannot reach.
 */
function labelForest(entriesByID: ReadonlyMap<number, EntryMeta>): IntervalForest {
	const childrenOf = new Map<number, number[]>()
	const rootIDs: number[] = []

	for (const [id, meta] of entriesByID) {
		const primary = meta.parentIDs[0]

		if (primary === undefined || !entriesByID.has(primary)) {
			// No parents, or a declared parent absent from this build: a forest root. The declared id
			// is still stored in the parent table.
			rootIDs.push(id)
		} else {
			let siblings = childrenOf.get(primary)

			if (!siblings) {
				childrenOf.set(primary, (siblings = []))
			}

			siblings.push(id)
		}
	}

	const roots = rootIDs.toSorted((a, b) => a - b)

	for (const [primary, siblings] of childrenOf) {
		childrenOf.set(
			primary,
			siblings.toSorted((a, b) => a - b)
		)
	}

	const preOf = new Map<number, number>()
	const postOf = new Map<number, number>()
	const ordinalOf = new Map<number, number>()
	const ordinals: number[] = []
	let counter = 0

	const discover = (id: number): void => {
		preOf.set(id, counter++)
		ordinalOf.set(id, ordinals.length)
		ordinals.push(id)
	}

	for (const rootID of roots) {
		discover(rootID)
		const frames: Array<{ id: number; nextChild: number }> = [{ id: rootID, nextChild: 0 }]

		while (frames.length) {
			const frame = frames.at(-1)!
			const children = childrenOf.get(frame.id) ?? []

			if (frame.nextChild < children.length) {
				const childID = children[frame.nextChild]!

				frame.nextChild++
				discover(childID)
				frames.push({ id: childID, nextChild: 0 })
			} else {
				postOf.set(frame.id, counter++)
				frames.pop()
			}
		}
	}

	if (ordinals.length !== entriesByID.size) {
		const stranded = [...entriesByID.keys()].find((id) => !preOf.has(id))

		throw new Error(`primary-parent cycle: entry ${stranded} is not reachable from any forest root`)
	}

	return { preOf, postOf, ordinals, ordinalOf }
}

export class AncestrieBuilder {
	private readonly root: TrieNode = { edges: new Map(), entryIDs: [] }
	private readonly entriesByID = new Map<number, EntryMeta>()
	private readonly normalizeToken: TokenNormalizer | undefined

	constructor(options: AncestrieBuilderOptions = {}) {
		this.normalizeToken = options.normalizeToken
	}

	/**
	 * Number of unique entry ids added so far.
	 */
	get entryCount(): number {
		return this.entriesByID.size
	}

	/**
	 * Add one entry. May be called several times with the same `id` under different token sequences (aliases); the
	 * id-carried fields — rank, parents, payload — must be identical on every add, and a divergence throws rather than
	 * silently keeping one.
	 */
	add(entry: AncestrieEntry): void {
		const normalize = this.normalizeToken
		const tokens = normalize ? entry.tokens.map(normalize) : [...entry.tokens]

		if (!tokens.length) {
			throw new TypeError("an entry requires at least one token")
		}

		for (const token of tokens) {
			if (typeof token !== "string" || !token.length) {
				throw new TypeError(`entry ${entry.id} has an empty token after normalization`)
			}
		}

		assertU32(entry.id, "entry id")

		if (typeof entry.rank !== "number" || !Number.isFinite(entry.rank)) {
			throw new TypeError(`entry ${entry.id} rank must be a finite number`)
		}

		if (entry.parentIDs.length > U16_MAX) {
			throw new RangeError(`entry ${entry.id} declares more than ${U16_MAX} parents`)
		}

		for (const parentID of entry.parentIDs) {
			assertU32(parentID, `entry ${entry.id} parent id`)
		}

		this.registerMeta(entry)

		let node = this.root

		for (const token of tokens) {
			let next = node.edges.get(token)

			if (!next) {
				next = { edges: new Map(), entryIDs: [] }
				node.edges.set(token, next)
			}

			node = next
		}

		if (!node.entryIDs.includes(entry.id)) {
			node.entryIDs.push(entry.id)
		}
	}

	/**
	 * Seal into the versioned binary: canonicalize the trie, label the primary-parent forest with pre/post intervals, and
	 * serialize. Throws on a primary-parent cycle. Does not consume the builder — sealing twice yields identical bytes.
	 */
	seal(options: SealOptions = {}): Uint8Array {
		const states = canonicalizeTrie(this.root)
		const forest = labelForest(this.entriesByID)

		// --- String interning: sorted unique tokens ---
		const tokenSet = new Set<string>()

		for (const state of states) {
			for (const [token] of state.edges) {
				tokenSet.add(token)
			}
		}

		const strings = [...tokenSet].toSorted()
		const stringIndex = new Map<string, number>()

		for (let i = 0; i < strings.length; i++) {
			stringIndex.set(strings[i]!, i)
		}

		const encodedStrings = strings.map((s) => UTF8_ENCODER.encode(s))
		const stringBytes = encodedStrings.reduce((sum, b) => sum + b.length, 0)

		// --- Counts ---
		let edgeCount = 0
		let entryRefCount = 0

		for (const state of states) {
			edgeCount += state.edges.length
			entryRefCount += state.entryIDs.length
		}

		let parentIDCount = 0
		let payloadBytes = 0

		for (const id of forest.ordinals) {
			const meta = this.entriesByID.get(id)!
			parentIDCount += meta.parentIDs.length
			payloadBytes += meta.payload?.bytes.length ?? 0
		}

		const header: AncestrieHeader = {
			version: ANCESTRIE_FORMAT_VERSION,
			stateCount: states.length,
			edgeCount,
			entryRefCount,
			entryCount: forest.ordinals.length,
			parentIDCount,
			stringCount: strings.length,
			stringBytes,
			payloadBytes,
			metadataOffset: 0,
		}

		const sections = computeSections(header)

		const metadataJSON =
			options.metadata === undefined ? undefined : UTF8_ENCODER.encode(JSON.stringify(options.metadata))

		if (metadataJSON) {
			header.metadataOffset = sections.end
		}

		const totalSize = sections.end + (metadataJSON ? 4 + metadataJSON.length : 0)
		const bytes = new Uint8Array(totalSize)
		const view = new DataView(bytes.buffer)

		writeHeader(view, header)

		// --- String table ---
		let stringOffset = 0

		for (let i = 0; i < encodedStrings.length; i++) {
			view.setUint32(sections.stringOffsets + i * 4, stringOffset, true)
			bytes.set(encodedStrings[i]!, sections.stringData + stringOffset)
			stringOffset += encodedStrings[i]!.length
		}

		view.setUint32(sections.stringOffsets + encodedStrings.length * 4, stringOffset, true)

		// --- State, edge, and entry-ref tables ---
		let edgeIdx = 0
		let entryRefIdx = 0

		for (let si = 0; si < states.length; si++) {
			const state = states[si]!
			const statePos = sections.stateTable + si * STATE_ENTRY_SIZE

			view.setUint32(statePos, edgeIdx, true)
			view.setUint32(statePos + 4, state.edges.length, true)
			view.setUint32(statePos + 8, entryRefIdx, true)
			view.setUint32(statePos + 12, state.entryIDs.length, true)

			for (const [token, target] of state.edges) {
				const edgePos = sections.edgeTable + edgeIdx * EDGE_ENTRY_SIZE
				view.setUint32(edgePos, stringIndex.get(token)!, true)
				view.setUint32(edgePos + 4, target, true)

				edgeIdx++
			}

			// Rank-descending then id-ascending, so a reader's top-k at a state is its first k refs.
			// Ranks compare at f32 precision — the precision the artifact stores.
			const refs = state.entryIDs.toSorted((a, b) => {
				const rankA = Math.fround(this.entriesByID.get(a)!.rank)
				const rankB = Math.fround(this.entriesByID.get(b)!.rank)

				return rankB - rankA || a - b
			})

			for (const id of refs) {
				view.setUint32(sections.entryRefTable + entryRefIdx * ENTRY_REF_SIZE, forest.ordinalOf.get(id)!, true)

				entryRefIdx++
			}
		}

		// --- Entry table, parent table, payload blob (all in pre-order) ---
		let parentIdx = 0
		let payloadOffset = 0

		for (let ordinal = 0; ordinal < forest.ordinals.length; ordinal++) {
			const id = forest.ordinals[ordinal]!
			const meta = this.entriesByID.get(id)!
			const recordPos = sections.entryTable + ordinal * ENTRY_RECORD_SIZE
			const payload = meta.payload

			let flags = 0

			if (payload) {
				flags |= ENTRY_FLAG_HAS_PAYLOAD

				if (payload.isJSON) {
					flags |= ENTRY_FLAG_PAYLOAD_JSON
				}
			}

			view.setUint32(recordPos, id, true)
			view.setUint32(recordPos + 4, forest.preOf.get(id)!, true)
			view.setUint32(recordPos + 8, forest.postOf.get(id)!, true)
			view.setFloat32(recordPos + 12, meta.rank, true)
			view.setUint32(recordPos + 16, parentIdx, true)
			view.setUint16(recordPos + 20, meta.parentIDs.length, true)
			view.setUint16(recordPos + 22, flags, true)
			view.setUint32(recordPos + 24, payloadOffset, true)
			view.setUint32(recordPos + 28, payload?.bytes.length ?? 0, true)

			for (const parentID of meta.parentIDs) {
				view.setUint32(sections.parentTable + parentIdx * 4, parentID, true)

				parentIdx++
			}

			if (payload) {
				bytes.set(payload.bytes, sections.payloadBlob + payloadOffset)
				payloadOffset += payload.bytes.length
			}
		}

		// --- ID index ---
		const sortedIDs = forest.ordinals.toSorted((a, b) => a - b)

		for (let i = 0; i < sortedIDs.length; i++) {
			const indexPos = sections.idIndex + i * ID_INDEX_ENTRY_SIZE
			view.setUint32(indexPos, sortedIDs[i]!, true)
			view.setUint32(indexPos + 4, forest.ordinalOf.get(sortedIDs[i]!)!, true)
		}

		// --- Metadata trailer ---
		if (metadataJSON) {
			view.setUint32(sections.end, metadataJSON.length, true)
			bytes.set(metadataJSON, sections.end + 4)
		}

		return bytes
	}

	/**
	 * Record (or verify) the id-carried fields of an entry — the alias contract: every add of the same id must agree.
	 */
	private registerMeta(entry: AncestrieEntry): void {
		const payload = encodePayload(entry.payload)
		const existing = this.entriesByID.get(entry.id)

		if (!existing) {
			this.entriesByID.set(entry.id, {
				rank: entry.rank,
				parentIDs: [...entry.parentIDs],
				...(payload === undefined ? {} : { payload }),
			})

			return
		}

		const sameParents =
			existing.parentIDs.length === entry.parentIDs.length &&
			existing.parentIDs.every((p, i) => p === entry.parentIDs[i])

		const samePayload =
			existing.payload === undefined
				? payload === undefined
				: payload !== undefined &&
					existing.payload.isJSON === payload.isJSON &&
					bytesEqual(existing.payload.bytes, payload.bytes)

		// Math.fround: the artifact stores rank as f32, so two adds that agree at f32 precision agree.
		if (Math.fround(existing.rank) !== Math.fround(entry.rank) || !sameParents || !samePayload) {
			throw new Error(`entry ${entry.id} was added twice with diverging rank, parents, or payload`)
		}
	}
}
