import { expect, test } from "vitest"

import { readLocalTextFile } from "#fs/readers"
import { temporaryDirectory } from "#fs/temporary"
import { writeLocalTextFile } from "#fs/writers"

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
