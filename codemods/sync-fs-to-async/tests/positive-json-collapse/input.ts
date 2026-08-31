import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { readFileSync } from "node:fs"

interface Manifest {
	version: string
}

/**
 * Already asynchronous, still spelling the serialization out — this is the campaign's own earlier output.
 */
export async function roundTrip(a: string, b: string): Promise<string> {
	const card = parseJSONStrict<Manifest>(await readLocalTextFile(a))

	await writeLocalTextFile(JSON.stringify(card, null, 2), b)

	return card.version
}

/**
 * The synchronous builtin under the same wrapper collapses in one step, type argument and all.
 */
export async function fromDisk(p: string): Promise<string> {
	return parseJSONStrict<Manifest>(readFileSync(p, "utf8")).version
}

/**
 * A REPLACER chooses which keys survive, so the output is not the value and this stays as it is.
 */
export async function filtered(value: object, p: string): Promise<void> {
	await writeLocalTextFile(JSON.stringify(value, ["a", "b"]), p)
}
