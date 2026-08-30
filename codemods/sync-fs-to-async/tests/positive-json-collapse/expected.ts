import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile, writeLocalJSONFile } from "@mailwoman/core/fs/writers"



interface Manifest {
	version: string
}

/**
 * Already asynchronous, still spelling the serialization out — this is the campaign's own earlier output.
 */
export async function roundTrip(a: string, b: string): Promise<string> {
	const card = await readLocalJSONFile<Manifest>(a)

	await writeLocalJSONFile(card, b)

	return card.version
}

/**
 * The synchronous builtin under the same wrapper collapses in one step, type argument and all.
 */
export async function fromDisk(p: string): Promise<string> {
	return (await readLocalJSONFile<Manifest>(p)).version
}

/**
 * A REPLACER chooses which keys survive, so the output is not the value and this stays as it is.
 */
export async function filtered(value: object, p: string): Promise<void> {
	await writeLocalTextFile(JSON.stringify(value, ["a", "b"]), p)
}
