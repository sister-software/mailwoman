/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The recipe line writer's delimiter contract.
 *
 *   A missing delimiter is silent at the point of the fault: two rows land on one line, and the error surfaces in
 *   whatever parses the output rather than in the recipe that wrote it. One line per call, and the delimiter as its
 *   own write, are what make that impossible.
 */

import { createRecipeLineWriter } from "@mailwoman/corpus/recipes/scaffold"
import { describe, expect, it } from "vitest"

/**
 * Records every chunk separately, so the test can tell one write of `"a\n"` from two writes of `"a"` and `"\n"`.
 */
function recordingSink() {
	const chunks: string[] = []

	return { chunks, write: (chunk: string) => chunks.push(chunk) }
}

describe("createRecipeLineWriter", () => {
	it("terminates every line, so two calls are two lines", () => {
		const sink = recordingSink()
		const write = createRecipeLineWriter(sink)

		write('{"a":1}')
		write('{"b":2}')

		expect(sink.chunks.join("")).toBe('{"a":1}\n{"b":2}\n')
	})

	it("writes the delimiter as its own chunk rather than concatenating it", () => {
		const sink = recordingSink()

		createRecipeLineWriter(sink)("row")

		// Concatenation would stringify a non-string chunk through `toString()` and corrupt its bytes.
		expect(sink.chunks).toEqual(["row", "\n"])
	})

	it("emits an empty line rather than nothing, so a blank row still advances the file", () => {
		const sink = recordingSink()

		createRecipeLineWriter(sink)("")

		expect(sink.chunks.join("")).toBe("\n")
	})
})
