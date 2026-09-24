import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { expect, test } from "vitest"

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
