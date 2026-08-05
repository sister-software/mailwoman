/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   PFX1 postcode-prefix index (postcode-structure arc, mechanism 3 — B3-1). A postcode PREFIX is a
 *   partial code that still encodes ancestry: the GB outward code (`SW1A`), the US 3-digit sectional
 *   centre (`941`), the NI district (`BT9`). This artifact is the enumeration of those prefixes for
 *   one country, each carrying the admin ancestry it asserts and — WHEN THE SOURCE CAN HONESTLY
 *   SUPPORT ONE — a centroid with its own measured dispersion.
 *
 *   It exists to answer the abstention #1480 introduced. A unit postcode the gazetteer has never
 *   seen contributes nothing today; with PFX1 the UNIT still abstains and the PREFIX still speaks.
 *
 *   This file owns BOTH ends of the format — `serializePostcodePrefixIndex` (Node, build tooling)
 *   and `PostcodePrefixIndexResolver` (browser and server alike) — the same single-file discipline
 *   as `pair-index-resolver.ts`, `postcode-binary-resolver.ts` and `placetype-census.ts`, so the
 *   layout can never drift between writer and reader. The reader imports nothing from Node.
 *
 *   Binary layout (little-endian), following PCN1 exactly through the header:
 *
 *   ```
 *   magic "PFX1" (4 bytes)
 *   u32 headerLen, headerLen bytes of UTF-8 JSON (`PostcodePrefixHeader`)
 *   u32 ancestorCount
 *     ancestorCount × { u8 placetypeLen, placetype utf8, f64 wofID, u8 nameLen, name utf8 }
 *   u32 nodeCount
 *     nodeCount × {
 *       u8 prefixLen, prefix utf8,
 *       u8 ancestorRefCount, ancestorRefCount × u32 ancestorIdx,
 *       u8 flags,                       // bit0 = coordinate present, bit1 = radiusP95Km present
 *       [i16 latQ, i16 lonQ]            // only when bit0
 *       [f32 radiusP95Km]               // only when bit1
 *       u32 unitCount
 *     }
 *   ```
 *
 *   Nodes are sorted by `prefix` in UTF-16 code-unit order. Ancestors live in a shared DICTIONARY
 *   because a country's prefixes assert a handful of distinct admin surfaces between them — GB's
 *   2,863 outward codes reference five entries — so per-node inlining would be almost all repetition.
 *   `wofID` is an f64 rather than a u32 because WOF IDs are not bounded by 2^32 (the NI shard's own
 *   synthetic postcode IDs start at 9.8e12); f64 is exact to 2^53 and the serializer asserts it.
 *
 *   ## Three properties, each earned by a measurement, each enforced here rather than documented
 *
 *   **`radiusP95Km` is MANDATORY whenever a coordinate is present, and meaningless without one.**
 *   A US 1-digit band and a GB outward code are both "a prefix with a centroid" and they differ by
 *   200× (M-3: 695.8 km median p95 vs M-2's 3.24 km). An artifact that ships the coordinate without
 *   the radius invites a consumer to treat them alike, so {@link serializePostcodePrefixIndex}
 *   throws in both directions: a coordinate without a radius, and a radius without a coordinate.
 *
 *   **The coordinate is OPTIONAL and its absence is MEANINGFUL** — the ancestry-only tier. It is
 *   carried in a flags bit, never as a `0,0` sentinel, because a magnitude never carries its own
 *   absence. Northern Ireland is the standing case: 80 BT districts whose only permissively-licensed
 *   coordinate source attests 9.5% of the units, where a centroid would describe the SAMPLE and not
 *   the district.
 *
 *   **`radiusP95Km` uses the house nearest-rank percentile** (`core/utils/stats.ts`, index
 *   `floor(p/100 × n)`), which is not the only nearest-rank convention in circulation. The
 *   difference is small and real: over the 2,863 GB outward codes the median per-outward p95 radius
 *   is 3.2355 km under the house convention and 3.2184 km under `ceil(p/100 × n) − 1` (0.53%). A
 *   consumer comparing this field against a number computed elsewhere needs to know which one it is.
 *
 *   ## Where a consumer lives
 *
 *   Mechanism 3's first consumer is the RESOLVER, which does not depend on `@mailwoman/neural`. It
 *   should reach this artifact through {@link PostcodePrefixIndexLike} — a structural interface, the
 *   same `…Like` convention `PairIndexLike` and `PlacetypeCensusLike` use — rather than a package
 *   dependency. The format lives here because PFX1 is the fourth member of the PCB1/PIX1/PCN1 family
 *   and a reader's second consumer is the decode-time seam in `postcode-anchor.ts`; splitting the
 *   family across two workspaces would buy one import and cost the single-file guarantee.
 */

import { parseJSONStrict } from "@mailwoman/core/objects"

/**
 * "PFX1" little-endian (P=0x50 F=0x46 X=0x58 1=0x31)
 */
const MAGIC = 0x31_58_46_50
const KNOWN_SCHEMA_VERSION = 1

/**
 * Coordinate quantization, identical to PCB1's — `latQ = round(lat / 90 × 32767)`, giving ~300 m. A prefix prior whose
 * own p95 radius is measured in kilometres has nothing to gain from a finer grid.
 */
const LAT_Q = 32_767 / 90
const LON_Q = 32_767 / 180

const FLAG_HAS_COORDINATE = 0b0000_0001
const FLAG_HAS_RADIUS = 0b0000_0010

/**
 * Longest UTF-8 byte length a prefix or an ancestor name may occupy — both are length-prefixed with a `u8`.
 */
const MAX_U8_LEN = 255

/**
 * Largest integer an f64 represents exactly. WOF IDs are asserted against it at serialize time so a future ID beyond
 * the safe range fails the build rather than round-tripping to a neighbour.
 */
const MAX_EXACT_WOF_ID = Number.MAX_SAFE_INTEGER

/**
 * One admin surface a prefix asserts. Interned in the file's ancestor dictionary.
 */
export interface PostcodePrefixAncestor {
	/**
	 * WOF placetype of the surface (`"country"`, `"macroregion"`, `"region"`).
	 */
	placetype: string
	/**
	 * Who's on First ID of the surface — the join key a consumer resolves against the gazetteer.
	 */
	wofID: number
	/**
	 * Display name, carried so a trace line is readable without a gazetteer round-trip.
	 */
	name: string
}

/**
 * One prefix and everything it asserts.
 */
export interface PostcodePrefixNode {
	/**
	 * The prefix in the sanitized-query token shape (#920) — every non-letter/number stripped, uppercased for the
	 * letter-bearing systems: `"941"`, `"SW1A"`, `"BT9"`.
	 */
	prefix: string
	/**
	 * Admin ancestry the prefix asserts, COARSEST-FIRST. Empty when the prefix asserts none — which is a real answer, not
	 * a build failure: a GB outward code in one of the two documented border-straddling postcode areas asserts the United
	 * Kingdom and nothing finer.
	 */
	ancestors: readonly PostcodePrefixAncestor[]
	/**
	 * Centroid latitude. ABSENT (with {@link PostcodePrefixNode.lon}) for the ancestry-only tier. Never `0`-as-absent.
	 */
	lat?: number
	lon?: number
	/**
	 * The measured p95 great-circle distance, in km, from this prefix's centroid to the units observed under it — the
	 * prior's own confidence, shipped rather than assumed. MANDATORY whenever a coordinate is present, and forbidden
	 * without one.
	 */
	radiusP95Km?: number
	/**
	 * Units OBSERVED under this prefix at build time — the denominator behind `radiusP95Km`, and, for a partial source,
	 * the number that says how partial. It is an observation, never a claim about how many units exist.
	 */
	unitCount: number
}

/**
 * Coverage tier of the source the index was built from, in the sense `docs/engineering/reference/layer-contract.mdx`
 * uses. Not part of the arc document's preregistered header; added because the NI source is ODbL and a share-alike
 * obligation that does not travel with the artifact is a licensing defect waiting for the first consumer.
 */
export type PostcodePrefixTier = "shipped" | "build-local"

export interface PostcodePrefixHeader {
	/**
	 * ISO country code this index was built for.
	 */
	country: string
	/**
	 * Sub-national scope slug, because a country's prefixes can come from more than one numbering register with different
	 * licences and different coverage: `"gb-esw"` is Code-Point Open (England, Scotland, Wales — NO Northern Ireland),
	 * `"gb-ni"` is the BT districts. Two files may therefore share a `country`; this is what tells them apart, and it is
	 * the filename suffix. Not in the arc document's preregistered header — added because folding the two GB registers
	 * into one file would have merged an OGL artifact with an ODbL one.
	 */
	scope: string
	schemaVersion: 1
	/**
	 * Which prefix granularity the node table carries — `["outward"]` for GB, `["3"]` for a US sectional-centre build.
	 */
	levels: readonly string[]
	/**
	 * The NUMBERING AUTHORITY the prefixes came from, NOT the gazetteer they were joined to. M-3 is the receipt: 7.9% of
	 * US ZIPs disagree with their own gazetteer parent's state because a firm/unique ZIP names an organization's mail
	 * processor rather than the code's range, so an index derived from `spr.parent_id` bakes that misattribution in.
	 */
	source: string
	/**
	 * MD5s of the source artifact(s), for provenance — the same discipline as PCN1's `sourceMD5s`.
	 */
	sourceMD5s: string[]
	/**
	 * ISO date the index was built.
	 */
	buildDate: string
	/**
	 * Coverage tier of the source. See {@link PostcodePrefixTier}.
	 */
	tier: PostcodePrefixTier
	/**
	 * Licence attribution carried through from the source artifact, so an artifact that is copied somewhere still names
	 * the terms it travels under.
	 */
	attribution: string
	/**
	 * What a MISS means for this file — the meaning-of-zero statement, mandatory. A prefix absent from a complete
	 * register does not exist; a prefix absent from a partial one may simply be unattested, and a consumer that cannot
	 * tell the two apart will read coverage as fact.
	 */
	coverageNote: string
	/**
	 * OPTIONAL soft-prior bias magnitude. ABSENT until a calibration task measures one — a defaulted number here would
	 * let an uncalibrated bias reach the decoder unnoticed (PCN1's rule, verbatim). B3-1 ships data + loader + offline
	 * probe with NO decode wiring, so nothing reads this yet.
	 */
	delta?: number
}

function ancestorKey(a: PostcodePrefixAncestor): string {
	return `${a.placetype} ${a.wofID} ${a.name}`
}

/**
 * Serialize a postcode-prefix index to PFX1 bytes.
 *
 * Refuses, loudly, three things a plausible-looking artifact could otherwise hide: a duplicate prefix (two extractions
 * merged without summing), a coordinate with no `radiusP95Km` (a consumer would read a 696 km band like a 3 km outward
 * code), and a `radiusP95Km` with no coordinate (a dispersion measured to nothing).
 */
export function serializePostcodePrefixIndex(
	header: PostcodePrefixHeader,
	nodes: readonly PostcodePrefixNode[]
): Buffer {
	const seen = new Set<string>()

	for (const node of nodes) {
		if (seen.has(node.prefix)) {
			throw new Error(
				`serializePostcodePrefixIndex: duplicate prefix "${node.prefix}" — dedupe (and SUM unitCount) before serializing`
			)
		}

		seen.add(node.prefix)

		const hasCoordinate = node.lat !== undefined || node.lon !== undefined

		if (hasCoordinate && (node.lat === undefined || node.lon === undefined)) {
			throw new Error(`serializePostcodePrefixIndex: prefix "${node.prefix}" carries half a coordinate`)
		}

		if (hasCoordinate && node.radiusP95Km === undefined) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has a coordinate but no radiusP95Km — the radius is ` +
					`MANDATORY beside a coordinate, because a prefix centroid without its dispersion reads like a precise point`
			)
		}

		if (!hasCoordinate && node.radiusP95Km !== undefined) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has a radiusP95Km but no coordinate — a dispersion ` +
					`with no centroid to disperse around is not a measurement`
			)
		}
	}

	const encoder = new TextEncoder()
	const headerBytes = encoder.encode(JSON.stringify(header))

	// Ancestor dictionary, in first-seen order so the file is deterministic for a deterministic node order.
	const ancestorIndex = new Map<string, number>()
	const ancestorTable: PostcodePrefixAncestor[] = []

	const sorted = nodes.toSorted((a, b) => (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0))

	for (const node of sorted) {
		for (const ancestor of node.ancestors) {
			const key = ancestorKey(ancestor)

			if (ancestorIndex.has(key)) continue

			if (!Number.isInteger(ancestor.wofID) || Math.abs(ancestor.wofID) > MAX_EXACT_WOF_ID) {
				throw new Error(
					`serializePostcodePrefixIndex: wofID ${ancestor.wofID} ("${ancestor.name}") is not an exactly-representable integer`
				)
			}

			ancestorIndex.set(key, ancestorTable.length)
			ancestorTable.push(ancestor)
		}
	}

	const encodedAncestors = ancestorTable.map((a) => {
		const placetype = encoder.encode(a.placetype)
		const name = encoder.encode(a.name)

		if (placetype.length > MAX_U8_LEN || name.length > MAX_U8_LEN) {
			throw new Error(`serializePostcodePrefixIndex: ancestor "${a.name}" exceeds the u8 length prefix`)
		}

		return { placetype, name, wofID: a.wofID }
	})

	const encodedNodes = sorted.map((node) => {
		const prefix = encoder.encode(node.prefix)

		if (!prefix.length || prefix.length > MAX_U8_LEN) {
			throw new Error(`serializePostcodePrefixIndex: prefix "${node.prefix}" is empty or exceeds the u8 length prefix`)
		}

		if (node.ancestors.length > MAX_U8_LEN) {
			throw new Error(
				`serializePostcodePrefixIndex: prefix "${node.prefix}" has more ancestors than the u8 count holds`
			)
		}

		const refs = node.ancestors.map((a) => ancestorIndex.get(ancestorKey(a))!)

		return { node, prefix, refs }
	})

	let size = 4 + 4 + headerBytes.length + 4

	for (const a of encodedAncestors) {
		size += 1 + a.placetype.length + 8 + 1 + a.name.length
	}

	size += 4

	for (const { node, prefix, refs } of encodedNodes) {
		size += 1 + prefix.length + 1 + refs.length * 4 + 1 + 4

		if (node.lat !== undefined) {
			size += 4
		}

		if (node.radiusP95Km !== undefined) {
			size += 4
		}
	}

	const buffer = Buffer.alloc(size)
	let offset = 0

	buffer.writeUInt32LE(MAGIC, offset)
	offset += 4
	buffer.writeUInt32LE(headerBytes.length, offset)
	offset += 4
	buffer.set(headerBytes, offset)
	offset += headerBytes.length

	buffer.writeUInt32LE(encodedAncestors.length, offset)
	offset += 4

	for (const a of encodedAncestors) {
		buffer.writeUInt8(a.placetype.length, offset)
		offset += 1
		buffer.set(a.placetype, offset)
		offset += a.placetype.length
		buffer.writeDoubleLE(a.wofID, offset)
		offset += 8
		buffer.writeUInt8(a.name.length, offset)
		offset += 1
		buffer.set(a.name, offset)
		offset += a.name.length
	}

	buffer.writeUInt32LE(encodedNodes.length, offset)
	offset += 4

	for (const { node, prefix, refs } of encodedNodes) {
		buffer.writeUInt8(prefix.length, offset)
		offset += 1
		buffer.set(prefix, offset)
		offset += prefix.length

		buffer.writeUInt8(refs.length, offset)
		offset += 1

		for (const ref of refs) {
			buffer.writeUInt32LE(ref, offset)
			offset += 4
		}

		const flags =
			(node.lat === undefined ? 0 : FLAG_HAS_COORDINATE) | (node.radiusP95Km === undefined ? 0 : FLAG_HAS_RADIUS)

		buffer.writeUInt8(flags, offset)
		offset += 1

		if (node.lat !== undefined && node.lon !== undefined) {
			buffer.writeInt16LE(Math.round(node.lat * LAT_Q), offset)
			offset += 2
			buffer.writeInt16LE(Math.round(node.lon * LON_Q), offset)
			offset += 2
		}

		if (node.radiusP95Km !== undefined) {
			buffer.writeFloatLE(node.radiusP95Km, offset)
			offset += 4
		}

		buffer.writeUInt32LE(node.unitCount, offset)
		offset += 4
	}

	return buffer
}

/**
 * Minimal subset of {@link PostcodePrefixIndexResolver} a consumer module reads — structural typing so a caller depends
 * on the shape rather than the class, and so `@mailwoman/resolver` can consume a prefix index without taking a
 * dependency on `@mailwoman/neural`.
 */
export interface PostcodePrefixIndexLike {
	probe(prefix: string): PostcodePrefixNode | null
	readonly country?: string
}

/**
 * Map-backed reader over PFX1 bytes. Pure JS, no Node imports — the browser runtime loads the same artifact.
 */
export class PostcodePrefixIndexResolver implements PostcodePrefixIndexLike {
	readonly header: PostcodePrefixHeader
	readonly #nodes: Map<string, PostcodePrefixNode>

	constructor(bytes: Uint8Array) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		let offset = 0

		if (view.getUint32(offset, true) !== MAGIC) {
			throw new Error("PostcodePrefixIndexResolver: bad magic — not a PFX1 artifact")
		}

		offset += 4

		const headerLen = view.getUint32(offset, true)
		offset += 4

		const decoder = new TextDecoder()

		this.header = parseJSONStrict<PostcodePrefixHeader>(decoder.decode(bytes.subarray(offset, offset + headerLen)))
		offset += headerLen

		if (this.header.schemaVersion !== KNOWN_SCHEMA_VERSION) {
			throw new Error(`PostcodePrefixIndexResolver: unsupported schemaVersion ${this.header.schemaVersion}`)
		}

		const ancestorCount = view.getUint32(offset, true)
		offset += 4

		const ancestors: PostcodePrefixAncestor[] = []

		for (let i = 0; i < ancestorCount; i++) {
			const placetypeLen = view.getUint8(offset)
			offset += 1
			const placetype = decoder.decode(bytes.subarray(offset, offset + placetypeLen))
			offset += placetypeLen
			const wofID = view.getFloat64(offset, true)
			offset += 8
			const nameLen = view.getUint8(offset)
			offset += 1
			const name = decoder.decode(bytes.subarray(offset, offset + nameLen))
			offset += nameLen

			ancestors.push({ placetype, wofID, name })
		}

		const nodeCount = view.getUint32(offset, true)
		offset += 4

		this.#nodes = new Map()

		for (let i = 0; i < nodeCount; i++) {
			const prefixLen = view.getUint8(offset)
			offset += 1
			const prefix = decoder.decode(bytes.subarray(offset, offset + prefixLen))
			offset += prefixLen

			const refCount = view.getUint8(offset)
			offset += 1

			const nodeAncestors: PostcodePrefixAncestor[] = []

			for (let r = 0; r < refCount; r++) {
				const idx = view.getUint32(offset, true)
				offset += 4

				const ancestor = ancestors[idx]

				if (!ancestor) {
					throw new Error(`PostcodePrefixIndexResolver: prefix "${prefix}" references ancestor ${idx}, out of range`)
				}

				nodeAncestors.push(ancestor)
			}

			const flags = view.getUint8(offset)
			offset += 1

			const node: PostcodePrefixNode = { prefix, ancestors: nodeAncestors, unitCount: 0 }

			if (flags & FLAG_HAS_COORDINATE) {
				node.lat = view.getInt16(offset, true) / LAT_Q
				offset += 2
				node.lon = view.getInt16(offset, true) / LON_Q
				offset += 2
			}

			if (flags & FLAG_HAS_RADIUS) {
				node.radiusP95Km = view.getFloat32(offset, true)
				offset += 4
			}

			node.unitCount = view.getUint32(offset, true)
			offset += 4

			this.#nodes.set(prefix, node)
		}
	}

	get size(): number {
		return this.#nodes.size
	}

	/**
	 * The header's ISO country code, so a load site can refuse an index built for a different country than the locale
	 * being parsed — the gate `PlacetypeCensusLike.country` exists for.
	 */
	get country(): string {
		return this.header.country
	}

	/**
	 * Every node, in the file's sorted order. The round-trip verification reads this; a runtime consumer wants
	 * {@link PostcodePrefixIndexResolver.probe}.
	 */
	nodes(): IterableIterator<PostcodePrefixNode> {
		return this.#nodes.values()
	}

	/**
	 * Look up one prefix. Returns `null` when the index has no node for it — ABSENCE IS NOT EVIDENCE. Read the header's
	 * `coverageNote` before treating a miss as anything but neutral: for a partial register a miss means UNATTESTED, and
	 * for a complete one it means the prefix is not in the numbering plan.
	 */
	probe(prefix: string): PostcodePrefixNode | null {
		return this.#nodes.get(prefix) ?? null
	}
}
