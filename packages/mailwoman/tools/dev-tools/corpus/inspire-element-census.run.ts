/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Count every distinct element name in an INSPIRE Addresses publication, over the whole file rather
 *   than a sample, and report whether the publisher writes the elements through which a natural
 *   person's name reaches an address.
 *
 *   A register source needs a personal-data reading before it is ingest-eligible, and only `absent`
 *   admits a source. For the INSPIRE Addresses schema that reading rests on one fact:
 *   `ad:locatorName` is the free-text `GeographicalName` through which a family name or a business name
 *   reaches an address, so a publisher that never writes it holds no party on an address. A count of
 *   zero over a sample does not establish absence, so this reads the whole member.
 *
 *   It reads the archive through {@linkcode inspireGMLChunks}, the same entry every INSPIRE adapter
 *   uses, so the census and the adapters read the same bytes. It counts element names over the decoded
 *   stream rather than through a schema-aware parse, because the census must cover every element the
 *   file uses and a parse that knows the schema reports only the elements it looks for.
 *
 *   Two boundary conditions decide whether the count is right. A chunk boundary can fall inside a tag
 *   name or inside a multi-byte character, so the stream is decoded with a stateful decoder and the
 *   text after the final `<` is held for the next chunk. Without that hold an element split across
 *   a boundary goes uncounted, and without the stateful decoder a split character becomes U+FFFD.
 *
 *   Run:
 *
 *       node packages/mailwoman/tools/dev-tools/corpus/inspire-element-census.run.ts --input <path to .zip or .gml>
 *       node packages/mailwoman/tools/dev-tools/corpus/inspire-element-census.run.ts --input <path> --member <name in the archive>
 *       node packages/mailwoman/tools/dev-tools/corpus/inspire-element-census.run.ts --url <https://…/AD.zip>
 *
 *   `--url` writes the publication to a temporary directory and removes it afterwards. A zip is read
 *   through its central directory. That directory sits at the end of the archive, so reading one entry
 *   needs the whole file on disk rather than a forward stream.
 */

import { pipeline } from "node:stream/promises"

import { APIClient } from "@mailwoman/core/api"
import { openReadStream, openWriteStream } from "@mailwoman/core/fs/streams"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { inspireGMLChunks } from "@mailwoman/corpus/inspire/archive"
import { basename } from "path-ts"

/**
 * The elements through which a free-text name reaches an INSPIRE address.
 *
 * `ad:locatorName` is the element itself and `ad:LocatorName` is the type, and a publisher may write
 * either spelling, so both are counted and a non-zero count in either refuses the `absent` reading.
 */
const PARTY_BEARING_ELEMENTS = ["ad:locatorName", "ad:LocatorName"] as const

const { values } = parseArguments({
	options: {
		input: { type: "string" },
		member: { type: "string" },
		url: { type: "string" },
	},
})

if (!values.input && !values.url) {
	throw new Error("Pass --input for a local archive or GML document, or --url for a remote one.")
}

await using scratch = values.url ? await temporaryDirectory("mailwoman-inspire-census-") : undefined

async function resolveInput(): Promise<string> {
	if (values.input) return values.input

	if (!values.url || !scratch) throw new Error("--url requires a temporary directory.")

	await using client = new APIClient({ displayName: "inspire-element-census" })

	const destination = scratch.path(basename(new URL(values.url).pathname))

	const response = await client.fetch<NodeJS.ReadableStream>({
		url: values.url,
		responseType: "stream",
		timeout: 600_000,
	})

	await pipeline(response.data, openWriteStream(destination))

	return destination.toString()
}

const input = await resolveInput()

// A `.gml` member is the one INSPIRE packs, so the default selector finds it without the caller naming it.
// `--member` picks a specific entry when an archive holds more than one.
const chunks = input.endsWith(".zip") ? inspireGMLChunks(input, values.member ?? /\.gml$/iu) : openReadStream(input)

const ELEMENT_NAME = /<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)[\s>/]/gu

const counts = new Map<string, number>()
const decoder = new TextDecoder("utf-8")
let bytes = 0
let carry = ""

function countNames(text: string): void {
	for (const match of text.matchAll(ELEMENT_NAME)) {
		const name = match[1]

		if (name) {
			counts.set(name, (counts.get(name) ?? 0) + 1)
		}
	}
}

for await (const chunk of chunks) {
	const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)

	bytes += buffer.length

	// `stream: true` holds a partial multi-byte character until its remaining bytes arrive,
	// so a boundary inside one character does not decode to U+FFFD.
	const text = carry + decoder.decode(buffer, { stream: true })

	// A tag starting before the boundary may not have ended yet, so everything from
	// the final `<` onward waits for the next chunk.
	// A scan here would count a truncated name.
	const lastOpen = text.lastIndexOf("<")

	if (lastOpen === -1) {
		carry = text

		continue
	}

	countNames(text.slice(0, lastOpen))
	carry = text.slice(lastOpen)
}

countNames(carry + decoder.decode())

const ordered = [...counts].toSorted((a, b) => b[1] - a[1])

console.log(`${values.url ?? input}: ${bytes} bytes decoded, ${counts.size} distinct element names`)
console.log("")

for (const [name, count] of ordered) {
	console.log(`  ${String(count).padStart(10)}  ${name}`)
}

console.log("")
console.log("party-bearing elements:")

for (const name of PARTY_BEARING_ELEMENTS) {
	console.log(`  ${name} appears ${counts.get(name) ?? 0} times`)
}
