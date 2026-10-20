import { readdir, readFile, readlink } from "node:fs/promises"

import { expect, test } from "vitest"

import { readLocalTextFile } from "#fs/readers"
import { temporaryDirectory } from "#fs/temporary"
import { createSymbolicLink, replaceFileAtomically, writeLocalBuffer, writeLocalTextFile } from "#fs/writers"

test("replaceFileAtomically never leaves the destination absent to a concurrent reader", async () => {
	await using scratch = await temporaryDirectory("writers-atomic-")
	const dest = scratch.path("postcode-us.bin")
	const sources = [scratch.path("a.bin"), scratch.path("b.bin")]

	await writeLocalBuffer(Buffer.alloc(4 << 20, 0x61), sources[0]!)
	await writeLocalBuffer(Buffer.alloc(4 << 20, 0x62), sources[1]!)
	await replaceFileAtomically(sources[0]!, dest)

	const state = { copying: true }
	let reads = 0
	const failures: string[] = []

	const reader = (async () => {
		while (state.copying) {
			try {
				const bytes = await readFile(dest.toString())

				if (bytes.length !== 4 << 20 || bytes[0] !== bytes.at(-1)) {
					failures.push("torn read")
				}
			} catch (error) {
				failures.push(String(error))
			}

			reads++
		}
	})()

	for (let i = 0; i < 40; i++) {
		await replaceFileAtomically(sources[i % 2]!, dest)
	}
	state.copying = false
	await reader

	expect(reads).toBeGreaterThan(0)
	expect(failures).toEqual([])
	expect((await readdir(scratch.path().toString())).toSorted()).toEqual(["a.bin", "b.bin", "postcode-us.bin"])
})

test("replaceFileAtomically replaces a symlink at the destination instead of writing through it", async () => {
	await using scratch = await temporaryDirectory("writers-atomic-link-")
	const linked = scratch.path("linked.txt")
	const dest = scratch.path("dest.txt")
	const source = scratch.path("source.txt")

	await writeLocalTextFile("original", linked)
	await writeLocalTextFile("replacement", source)
	await createSymbolicLink(linked, dest)
	await replaceFileAtomically(source, dest)

	expect(await readLocalTextFile(linked)).toBe("original")
	expect(await readLocalTextFile(dest)).toBe("replacement")
	await expect(readlink(dest.toString())).rejects.toThrow("EINVAL")
})

test("writeLocalTextFile streams async lines with one terminating newline per line", async () => {
	await using scratch = await temporaryDirectory("writers-")

	async function* lines(): AsyncGenerator<string> {
		yield "first"
		yield "second"
	}

	const output = scratch.path("lines.txt")
	await writeLocalTextFile(lines(), output)

	expect(await readLocalTextFile(output)).toBe("first\nsecond\n")
})
