/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Writes a small OpenStreetMap `.osm.pbf` file from tagged nodes, so the build recipe can be exercised
 *   end to end against a file GDAL's OSM driver reads, without downloading an extract.
 *
 *   The file is one `OSMHeader` blob and one `OSMData` blob holding a single `DenseNodes` group. Each blob
 *   stores its payload in the format's uncompressed `raw` field
 *   (https://wiki.openstreetmap.org/wiki/PBF_Format), which a fixture of a few nodes can afford. The writer
 *   encodes the few protobuf fields it needs by hand rather than taking a protobuf dependency.
 */

/**
 * One node with its tags.
 */
export interface PBFNode {
	id: number
	lat: number
	lon: number
	tags: Readonly<Record<string, string>>
}

/**
 * A protobuf message under construction.
 */
class Message {
	readonly #bytes: number[] = []

	static varint(value: bigint): number[] {
		const out: number[] = []
		let rest = BigInt.asUintN(64, value)

		do {
			let byte = Number(rest & 0x7fn)

			rest >>= 7n

			if (rest > 0n) {
				byte |= 0x80
			}

			out.push(byte)
		} while (rest > 0n)

		return out
	}

	static zigzag(value: bigint): bigint {
		return value >= 0n ? value << 1n : (-value << 1n) - 1n
	}

	#key(field: number, wireType: number): void {
		this.#bytes.push(...Message.varint(BigInt((field << 3) | wireType)))
	}

	uint(field: number, value: number): this {
		this.#key(field, 0)
		this.#bytes.push(...Message.varint(BigInt(value)))

		return this
	}

	bytes(field: number, value: Uint8Array): this {
		this.#key(field, 2)
		this.#bytes.push(...Message.varint(BigInt(value.length)), ...value)

		return this
	}

	string(field: number, value: string): this {
		return this.bytes(field, new TextEncoder().encode(value))
	}

	message(field: number, value: Message): this {
		return this.bytes(field, value.toBytes())
	}

	/**
	 * A packed repeated field of signed integers, zigzag-encoded.
	 */
	packedSigned(field: number, values: readonly bigint[]): this {
		return this.bytes(field, Uint8Array.from(values.flatMap((value) => Message.varint(Message.zigzag(value)))))
	}

	/**
	 * A packed repeated field of non-negative integers.
	 */
	packedUnsigned(field: number, values: readonly number[]): this {
		return this.bytes(field, Uint8Array.from(values.flatMap((value) => Message.varint(BigInt(value)))))
	}

	toBytes(): Uint8Array {
		return Uint8Array.from(this.#bytes)
	}
}

/**
 * One file block: the big-endian header length, the `BlobHeader`, and the
 * `Blob` holding the payload uncompressed.
 */
function fileBlock(type: string, payload: Uint8Array): Buffer {
	const blob = new Message().bytes(1, payload).toBytes()
	const header = new Message().string(1, type).uint(3, blob.length).toBytes()
	const length = Buffer.alloc(4)

	length.writeUInt32BE(header.length)

	return Buffer.concat([length, header, blob])
}

/**
 * Coordinates are stored in units of 100 nanodegrees, the format's default granularity.
 */
const GRANULARITY = 100

/**
 * The bytes of a `.osm.pbf` file holding `nodes`, sorted by id.
 */
export function writePBF(nodes: readonly PBFNode[]): Buffer {
	const sorted = nodes.toSorted((a, b) => a.id - b.id)
	const strings = [""]
	const index = new Map<string, number>([["", 0]])

	const intern = (value: string): number => {
		let found = index.get(value)

		if (found === undefined) {
			found = strings.length
			strings.push(value)
			index.set(value, found)
		}

		return found
	}

	const ids: bigint[] = []
	const lats: bigint[] = []
	const lons: bigint[] = []
	const keysVals: number[] = []
	let previous = { id: 0n, lat: 0n, lon: 0n }

	for (const node of sorted) {
		const id = BigInt(node.id)
		const lat = BigInt(Math.round((node.lat * 1e9) / GRANULARITY))
		const lon = BigInt(Math.round((node.lon * 1e9) / GRANULARITY))

		ids.push(id - previous.id)
		lats.push(lat - previous.lat)
		lons.push(lon - previous.lon)
		previous = { id, lat, lon }

		for (const [key, value] of Object.entries(node.tags)) {
			keysVals.push(intern(key), intern(value))
		}

		keysVals.push(0)
	}

	const dense = new Message().packedSigned(1, ids).packedSigned(8, lats).packedSigned(9, lons)

	dense.packedUnsigned(10, keysVals)

	const stringTable = new Message()

	for (const value of strings) {
		stringTable.string(1, value)
	}

	const block = new Message().message(1, stringTable).message(2, new Message().message(2, dense))
	const header = new Message().string(4, "OsmSchema-V0.6").string(4, "DenseNodes").string(16, "mailwoman-fixture")

	return Buffer.concat([fileBlock("OSMHeader", header.toBytes()), fileBlock("OSMData", block.toBytes())])
}
