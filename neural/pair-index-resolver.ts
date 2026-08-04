/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PIX1 placetype-pair index (placetype-pair-prior arc). A pure-JS, browser-safe lookup
 *   from a folded (child, parent) place-name pair to the `ComponentTag` the pair resolves to (e.g.
 *   "shoreditch" under "london" → `dependent_locality`) — the retrieval-augmented complement to the
 *   encoder's own judgment, following the same PCB1 single-file writer+reader pattern as
 *   `postcode-binary-resolver.ts` so the layout can never drift between the two ends.
 *
 *   This file owns BOTH ends of the format — `serializePairIndex` (run in Node by the shard-build
 *   tooling) and `PairIndexResolver` (run in the browser and server alike) — with zero Node imports
 *   in the reader path.
 *
 *   Binary layout (little-endian): magic "PIX1" (4 bytes) u32 headerLen, headerLen bytes of
 *   UTF-8-encoded JSON (`PairIndexHeader`) u32 pairCount, then pairCount records of:
 *
 *   ```
 *   u16 childLen, child utf8[childLen], u16 parentLen, parent utf8[parentLen], u8 tagIdx, u8 parentTagIdx
 *   ```
 *
 *   sorted by (child, parent) UTF-16 code-unit order. `tagIdx` and `parentTagIdx` BOTH index the
 *   header's `tagTable` — the copy of `COMPONENT_TAGS` embedded at serialize time (schema 3; u8 caps
 *   at 256 tags, asserted at serialize — the table is nowhere near that today), so the binary is
 *   self-describing and immune to reordering of the runtime tag union. Normative outside-contributor
 *   spec: `docs/engineering/reference/pix1.ksy` (kept honest by the layout-conformance test).
 *
 *   A record is a TYPED EDGE, and both ends are recorded. Schema 2 wrote only the child's tag and the
 *   decode side derived the parent's from `WESTERN_PARENT_OF` — which cannot express the edges the
 *   builders actually extract (the US WOF source emits a `dependent_locality` under a BOROUGH, itself
 *   a `dependent_locality`; containment says a `dependent_locality`'s only parent is `locality`). One
 *   byte per pair buys the source's own answer instead of a re-derived guess.
 *
 *   This departs from PCB1's fixed-width key table on purpose: postcodes are bounded (~7 ASCII
 *   chars), but place names vary widely in byte length, so a fixed-width key would either truncate
 *   long names or waste space padding short ones. A `u16`-length-prefixed UTF-8 string per field
 *   costs 2 extra bytes per pair — irrelevant at the ~20k-entry scale this index targets — in
 *   exchange for exact byte-for-byte names. `probe()` is Map-backed (built once in the constructor)
 *   rather than binary search, for the same reason: variable-width records make positional
 *   `record[i]` addressing awkward, and 20k entries is small enough that the Map's O(n) build cost
 *   and memory footprint are non-issues.
 *
 *   `child`/`parent` are expected to already be folded (NFKC-lowered, punctuation-stripped — see
 *   `normalizeFSTToken` in `fst-prior.ts`) by the caller; `foldVersion` in the header records which
 *   fold the entries were built against, so a consumer can detect a stale index if the fold changes.
 *
 *   Duplicate-tolerance is explicitly NOT a serializer concern: `serializePairIndex` asserts its
 *   input is already deduped by (child, parent) and throws otherwise. Building the shard is where
 *   duplicates should be resolved (e.g. picking the higher-confidence tag) — silently last-write-wins
 *   or first-write-wins at serialize time would hide a shard-build bug.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"
import { COMPONENT_TAGS, type ComponentTag } from "@mailwoman/core/types"

/**
 * Tags addressable by the single-byte index the pair table packs into.
 */
const MAX_TAGS_PER_BYTE = 256

/**
 * "PIX1" little-endian (P=0x50 I=0x49 X=0x58 1=0x31)
 */
const MAGIC = 0x31_58_49_50

/**
 * Schema 3 (2026-08-04): every record carries a second tag byte — the PARENT's `ComponentTag` — so a pair asserts the
 * WHOLE typed edge rather than half of it. Schema 2 (the tag table moving into the header, same day) is refused rather
 * than read: a v2 record stops after `tagIdx`, so decoding one as v3 would swallow the NEXT record's `childLen` as a
 * parent tag. Both breaks are deliberate (operator-ruled): the release pipeline rebuilds pair indexes anyway
 * (`copy-weights` → `gazetteer pair-index`), and a tolerant fallback would keep a wrong-by-construction artifact
 * alive.
 *
 * Why the parent tag is RECORDED and not derived. The #46 preregistration derived it from `WESTERN_PARENT_OF`, on the
 * argument that containment already owns the fact. It does not: containment maps a child tag to the parents the TREE
 * BUILDER will accept, which is a different question from what the extraction actually observed. The US borough source
 * emits (`Park Slope`, `Brooklyn`) — a `dependent_locality` under a `dependent_locality` — and containment's
 * `dependent_locality: ["locality"]` can never say that. Deriving also spends the bias across every allowed parent when
 * the set has more than one, so a `locality` child biased `subregion`/`region`/`country` alike and moved nothing.
 */
export const KNOWN_SCHEMA_VERSION = 3

export interface PairIndexEntry {
	/**
	 * Folded child place name (e.g. a dependent_locality or locality candidate).
	 */
	child: string
	/**
	 * Folded parent place name the child was observed under.
	 */
	parent: string
	/**
	 * The `ComponentTag` this (child, parent) pair resolves the CHILD to.
	 */
	tag: ComponentTag
	/**
	 * The `ComponentTag` the same pair resolves the PARENT to — the other half of the asserted edge (schema 3). Required:
	 * {@link serializePairIndex} refuses an entry that omits it or names something outside `COMPONENT_TAGS`. A builder
	 * that cannot state its parent's tag from its source's own semantics must not guess one — see
	 * `mailwoman/gazetteer-pipeline/borough-pairs.ts` for the worked case (the WOF parent row's placetype, projected
	 * through `PLACETYPE_PROJECTION`).
	 */
	parentTag: ComponentTag
}

/**
 * What a probe hit returns: the whole typed edge. Deliberately an object rather than the bare child tag — returning
 * half of a two-ended assertion is exactly the defect schema 3 exists to close, and a caller that only wants the child
 * reads `.tag` visibly rather than silently getting a half-answer.
 *
 * Instances are INTERNED per resolver (there are a handful of distinct (tag, parentTag) combinations across even the
 * 199k-entry FR artifact), so the probe map costs one pointer per entry, not one object per entry.
 */
export interface PairEdge {
	readonly tag: ComponentTag
	readonly parentTag: ComponentTag
}

export interface PairIndexHeader {
	/**
	 * ISO country code this shard was built for.
	 */
	country: string
	/**
	 * The soft-prior bias magnitude a probe hit should contribute (consumer-interpreted).
	 */
	delta: number
	schemaVersion: 3
	/**
	 * The tag universe `tagIdx` and `parentTagIdx` index into, embedded at serialize time (a copy of `COMPONENT_TAGS` as
	 * of the build). Makes the binary self-describing — an outside reader decodes tags with no mailwoman import — and
	 * decouples every shipped artifact from the ORDER of the runtime tag union. The reader resolves each record's name
	 * against the runtime's known tags and throws on a referenced unknown; unknown names no record references are
	 * tolerated, so a binary built after the union grows still loads on an older reader as long as the new tag is
	 * unused.
	 */
	tagTable: string[]
	/**
	 * Which fold (`normalizeFSTToken`-style normalization) the entries were built against.
	 */
	foldVersion: 1
	/**
	 * MD5s of the source file(s) this shard was built from, for provenance.
	 */
	sourceMD5s: string[]
	/**
	 * ISO date the shard was built.
	 */
	buildDate: string
	/**
	 * OPTIONAL per-country transition-bonus magnitude (TRANSITION-BETA build, 2026-07-24): on a pair hit, the prior emits
	 * a position-scoped decoder adjustment of `+transitionBeta` on every transition INTO `B-<tag>` at the child span's
	 * first piece — the path-fusion recovery lever the task-8 transition-level probe measured (β=5: 13/17 comma-free GB
	 * misses recovered, zero measured collateral on 47 correct rows + 200 venue-confound rows). ABSENT = no transition
	 * term at all (today's emission-only behavior) — backward compatible (old binaries lack the field and keep working)
	 * AND forward compatible (old readers parse the header JSON and simply never consult the extra key; optional fields
	 * ride the JSON header without a schema bump). Calibrated per country like `delta`: the GB artifact ships 5; the NZ
	 * artifact deliberately ships WITHOUT it (unmeasured there, and comma-free NZ is already at 99.2%).
	 */
	transitionBeta?: number
	/**
	 * OPTIONAL per-country WHOLE-EDGE bias magnitude (#46, default-on 2026-08-04): on a pair hit, the prior ALSO writes
	 * `+parentDelta` onto the record's `parentTag` over the parent window, not just `+delta` onto the child. ABSENT = no
	 * parent bias at all (the child-only behaviour every artifact carried before this) — absence-tolerant in the same
	 * sense as {@link transitionBeta}, and absence means OFF, never 0-as-a-default.
	 *
	 * Calibrated per country, and only where it was MEASURED. `us`/`gb`/`nz`/`fr` ship 5 — the smallest δ that saturates
	 * bar B-2's brooklyn-class sub-board, flat from there through 20
	 * (`docs/records/evals/2026-08-04-pix1-whole-edge-verdict.md`). `de`/`in`/`es`/`it` ship WITHOUT it: no board has
	 * graded the parent side there, and the D-rule's answer to an unmeasured locale is a per-locale gate, not an
	 * inherited magnitude.
	 *
	 * Overridable at decode: `PlacetypePairPriorOpts.parentDelta` (which `MAILWOMAN_PAIR_PARENT_DELTA` feeds) wins over
	 * the header, so an eval can sweep δ without rebuilding artifacts.
	 */
	parentDelta?: number
}

/**
 * The caller-supplied half of {@link PairIndexHeader}: everything except the two format-owned fields (`schemaVersion`,
 * `tagTable`), which {@link serializePairIndex} stamps itself — the format version is the serializer's fact, not the
 * builder's claim.
 */
export type PairIndexHeaderInput = Omit<PairIndexHeader, "schemaVersion" | "tagTable">

/**
 * Join a (child, parent) pair into a single unambiguous Map key. Folded place names can contain spaces (the fold leaves
 * Zs-category whitespace intact -- see normalizeFSTToken in fst-prior.ts), so a plain space delimiter would collide
 * ("new york" + "ny" vs "new" + "york ny" both naively join to "new york ny"). Prefixing with child's UTF-16 length
 * pins the exact split point regardless of what characters either string contains.
 */
function pairKey(child: string, parent: string): string {
	return `${child.length}:${child}:${parent}`
}

/**
 * Serialize (header, entries) into the PIX1 flat binary. Entries are sorted by (child, parent) so the format is
 * deterministic regardless of input order. Run in Node; consumed by {@link PairIndexResolver}.
 *
 * Throws if `entries` contains a duplicate (child, parent) pair (dedupe upstream — see the file-header note on why this
 * isn't silently resolved here), if a child/parent string exceeds the u16 length prefix (65,535 UTF-8 bytes — no real
 * place name approaches this), or if an entry's `tag` / `parentTag` is missing or is not a `ComponentTag`. The
 * `parentTag` check is not defensive noise: a builder that cannot state its parent's tag from its source's semantics
 * must fail loudly here rather than have a plausible-looking default written into a shipped artifact.
 */
export function serializePairIndex(header: PairIndexHeaderInput, entries: readonly PairIndexEntry[]): Uint8Array {
	if (COMPONENT_TAGS.length > MAX_TAGS_PER_BYTE) {
		throw new Error(
			`pair index: COMPONENT_TAGS has ${COMPONENT_TAGS.length} tags, which exceeds the u8 tagIdx cap (256)`
		)
	}

	// The serializer owns the format-level fields: the schema version it writes and the tag table its
	// tagIdx values index into are one fact, stamped together.
	const fullHeader: PairIndexHeader = { ...header, schemaVersion: KNOWN_SCHEMA_VERSION, tagTable: [...COMPONENT_TAGS] }

	const tagIndex = new Map<ComponentTag, number>(COMPONENT_TAGS.map((tag, i) => [tag, i]))

	// oxlint-disable-next-line unicorn/no-array-sort -- sorts a freshly-built array; toSorted would double-allocate on a hot path
	const sorted = [...entries].sort((a, b) =>
		a.child < b.child ? -1 : a.child > b.child ? 1 : a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0
	)

	for (let i = 1; i < sorted.length; i++) {
		const prev = sorted[i - 1]!
		const cur = sorted[i]!

		if (cur.child === prev.child && cur.parent === prev.parent) {
			throw new Error(`pair index: duplicate (child, parent) pair "${cur.child}" / "${cur.parent}" — dedupe upstream`)
		}
	}

	const encoder = new TextEncoder()

	const encodedPairs = sorted.map((e) => {
		const child = encoder.encode(e.child)
		const parent = encoder.encode(e.parent)

		if (child.length > 0xff_ff || parent.length > 0xff_ff) {
			throw new Error(`pair index: "${e.child}" / "${e.parent}" exceeds the u16 length prefix`)
		}

		const tagIdx = tagIndex.get(e.tag)

		if (tagIdx === undefined) {
			throw new Error(`pair index: unrecognized ComponentTag "${e.tag}"`)
		}

		const parentTagIdx = tagIndex.get(e.parentTag)

		if (parentTagIdx === undefined) {
			throw new Error(
				`pair index: entry "${e.child}" / "${e.parent}" has an unrecognized parentTag "${e.parentTag}" — ` +
					`every schema-3 record states BOTH ends of the edge; the builder must read the parent's tag from its ` +
					`source's own semantics rather than defaulting one`
			)
		}

		return { child, parent, tagIdx, parentTagIdx }
	})

	const headerBytes = encoder.encode(JSON.stringify(fullHeader))

	let size = 4 /* magic */ + 4 /* headerLen */ + headerBytes.length + 4

	/* pairCount */

	for (const p of encodedPairs) {
		size += 2 + p.child.length + 2 + p.parent.length + 1 /* tagIdx */ + 1 /* parentTagIdx */
	}

	const buf = new Uint8Array(size)
	const view = new DataView(buf.buffer)

	let o = 0
	view.setUint32(o, MAGIC, true)
	o += 4
	view.setUint32(o, headerBytes.length, true)
	o += 4
	buf.set(headerBytes, o)
	o += headerBytes.length
	view.setUint32(o, encodedPairs.length, true)
	o += 4

	for (const p of encodedPairs) {
		view.setUint16(o, p.child.length, true)
		o += 2
		buf.set(p.child, o)
		o += p.child.length
		view.setUint16(o, p.parent.length, true)
		o += 2
		buf.set(p.parent, o)
		o += p.parent.length
		buf[o++] = p.tagIdx
		buf[o++] = p.parentTagIdx
	}

	return buf
}

/**
 * Read just the magic + header block (no entry parsing, no Map build) — the same validation the constructor does
 * (bad-magic throw, future-schema throw) but stops the instant the header JSON is decoded. Lets a caller inspect
 * `country`/`delta`/`sourceMD5s` etc. before paying for the full entry parse — e.g.
 * `NeuralAddressClassifier.loadFromWeights`'s hard country gate (`classifier.ts`) reads this FIRST and only constructs
 * a `PairIndexResolver` (which walks every entry to build the probe `Map`) when the header's country matches the
 * resolved locale; a mismatch skips construction entirely rather than paying the full parse just to discard the
 * result.
 */
export function peekPairIndexHeader(bytes: Uint8Array): PairIndexHeader {
	return readHeaderBlock(bytes).header
}

/**
 * Shared magic+header decode used by both {@link peekPairIndexHeader} and the {@link PairIndexResolver} constructor, so
 * the two can never drift on what counts as a valid header. Returns the parsed header AND the byte offset immediately
 * following it, so the constructor can resume entry parsing from exactly where this left off without re-decoding.
 */
function readHeaderBlock(bytes: Uint8Array): { header: PairIndexHeader; offset: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	if (view.getUint32(0, true) !== MAGIC) throw new Error("pair index: bad magic")

	let o = 4
	const headerLen = view.getUint32(o, true)
	o += 4
	const decoder = new TextDecoder()
	const header = parseJSONStrict<PairIndexHeader>(decoder.decode(bytes.subarray(o, o + headerLen)))
	o += headerLen

	if (header.schemaVersion < KNOWN_SCHEMA_VERSION) {
		throw new Error(
			`pair index: schemaVersion ${header.schemaVersion} predates the typed parent record (v3, 2026-08-04) — ` +
				`rebuild the artifact via \`mailwoman gazetteer pair-index\``
		)
	}

	if (header.schemaVersion > KNOWN_SCHEMA_VERSION) {
		throw new Error(
			`pair index: schemaVersion ${header.schemaVersion} is newer than this reader knows (known up to ${KNOWN_SCHEMA_VERSION})`
		)
	}

	return { header, offset: o }
}

/**
 * Pure-JS, browser-safe reader over the PIX1 flat binary. Builds a `Map<pairKey, PairEdge>` once in the constructor
 * (cheap at the ~20k-entry scale this index targets) so `probe()` is O(1). The `PairEdge` values are interned across
 * records — the FR artifact's 199k entries share a single frozen object — so the second tag byte costs the map no extra
 * allocation.
 */
export class PairIndexResolver {
	readonly header: PairIndexHeader
	readonly #probeMap: ReadonlyMap<string, PairEdge>

	constructor(bytes: Uint8Array) {
		const { header, offset } = readHeaderBlock(bytes)

		this.header = header

		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let o = offset
		const pairCount = view.getUint32(o, true)
		o += 4

		const decoder = new TextDecoder()
		const map = new Map<string, PairEdge>()

		// Decode through the EMBEDDED table, validated per-record against the runtime's known tags:
		// a referenced unknown name (or an out-of-range tagIdx/parentTagIdx) is a hard error, while unknown
		// table entries no record references are tolerated — see the tagTable docstring.
		const knownTags = new Set<string>(COMPONENT_TAGS)
		// Interning pool: the (tag, parentTag) product is tiny in practice (one combination on every shipped
		// register artifact, a handful across the WOF-sourced ones), so one shared object per combination
		// keeps a 199k-entry index at one pointer per record.
		const edges = new Map<string, PairEdge>()

		const resolveTag = (idx: number, field: "tagIdx" | "parentTagIdx"): ComponentTag => {
			const name = header.tagTable[idx]

			if (name === undefined) {
				throw new Error(`pair index: ${field} ${idx} is outside the header's tagTable (${header.tagTable.length})`)
			}

			if (!knownTags.has(name)) {
				throw new Error(`pair index: tagTable entry "${name}" is not a ComponentTag this reader knows`)
			}

			return name as ComponentTag
		}

		for (let i = 0; i < pairCount; i++) {
			const childLen = view.getUint16(o, true)
			o += 2
			const child = decoder.decode(bytes.subarray(o, o + childLen))
			o += childLen
			const parentLen = view.getUint16(o, true)
			o += 2
			const parent = decoder.decode(bytes.subarray(o, o + parentLen))
			o += parentLen
			const tagIdx = bytes[o++]!
			const parentTagIdx = bytes[o++]!
			const edgeKey = `${tagIdx}:${parentTagIdx}`

			let edge = edges.get(edgeKey)

			if (!edge) {
				edge = Object.freeze({
					tag: resolveTag(tagIdx, "tagIdx"),
					parentTag: resolveTag(parentTagIdx, "parentTagIdx"),
				})

				edges.set(edgeKey, edge)
			}

			map.set(pairKey(child, parent), edge)
		}

		this.#probeMap = map
	}

	/**
	 * Look up the typed edge a folded (child, parent) pair asserts, or `undefined` if the index has no entry for it.
	 * Returns BOTH tags — a caller that only wants the child's reads `.tag`. See {@link PairEdge} for why this is not the
	 * bare child tag.
	 */
	probe(childFolded: string, parentFolded: string): PairEdge | undefined {
		return this.#probeMap.get(pairKey(childFolded, parentFolded))
	}

	/**
	 * Exposes the calibrated delta bias magnitude so the resolver conforms to {@link PairIndexLike} and can be passed
	 * directly.
	 */
	get delta(): number {
		return this.header.delta
	}

	/**
	 * Exposes the header's ISO country code so the resolver conforms to {@link PairIndexLike}. Consumed by the
	 * placetype-pair prior's segment path to pick the country-specific trailing-postcode shape it strips before folding a
	 * parent-candidate segment key (see `placetype-pair-prior.ts`'s `segmentParentPostcodeShape`).
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Exposes the optional transition-bonus magnitude (see {@link PairIndexHeader.transitionBeta}) so the resolver
	 * conforms to {@link PairIndexLike}. `undefined` on a binary built without the field — the prior then emits no
	 * transition adjustments (the pre-TRANSITION-BETA behavior, exactly).
	 */
	get transitionBeta(): number | undefined {
		return this.header.transitionBeta
	}

	/**
	 * Exposes the optional whole-edge parent-bias magnitude (see {@link PairIndexHeader.parentDelta}) so the resolver
	 * conforms to {@link PairIndexLike}. `undefined` on an artifact built without it — the prior then writes no parent
	 * bias at all, which is the pre-#46 behaviour exactly.
	 */
	get parentDelta(): number | undefined {
		return this.header.parentDelta
	}
}

/**
 * Minimal subset of `PairIndexResolver` a prior module consumes — structural typing so callers depend on the shape, not
 * the class (the `query-shape-prior.ts` "…Like" convention). `delta` is optional because a hand-built test double may
 * omit it; a real index's header carries the authoritative value. `transitionBeta` is optional in BOTH senses: a test
 * double may omit it, and a real header legitimately lacks it (see {@link PairIndexHeader.transitionBeta} — absent means
 * no transition term, not a default).
 */
export interface PairIndexLike {
	probe(child: string, parent: string): PairEdge | undefined
	readonly delta?: number
	readonly transitionBeta?: number
	/**
	 * The header's whole-edge parent-bias magnitude (see {@link PairIndexHeader.parentDelta}). Optional in both senses,
	 * like `transitionBeta`: a hand-built double may omit it, and a real header legitimately lacks it (an unmeasured
	 * locale ships without one). An explicit `PlacetypePairPriorOpts.parentDelta` overrides whatever this says.
	 */
	readonly parentDelta?: number
	/**
	 * The index header's ISO country code (lowercase, e.g. `"gb"`/`"nz"`). Optional for the same two reasons as `delta`
	 * and `transitionBeta`: a hand-built test double may omit it, and it drives an OPTIONAL behavior — the segment path's
	 * country-aware trailing-postcode strip (see `placetype-pair-prior.ts`'s `segmentParentPostcodeShape`). Absent, or a
	 * country with no known postcode shape → no strip (byte-stable).
	 */
	readonly country?: string
}
