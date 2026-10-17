/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The recipe line writer's delimiter interface.
 *
 *   When the writer omits a delimiter, two rows land on one line.
 *   A later parser reports the error instead of the recipe writer.
 *   The writer emits one line per call and writes the delimiter separately.
 *   This interface prevents the missing-delimiter failure.
 */

import { describe, expect, it } from "vitest"

import { createRecipeLineWriter, admittingRecipeLineWriter } from "#recipes/scaffold"
import { readAddressSourceRegister } from "#source-register"
import { createSourceRightsAdmission, readCorpusSourceInputs } from "#source-register/corpus-inputs"

/**
 * Records every chunk separately, so the test can tell one write of `"a\n"`
 * from two writes of `"a"` and `"\n"`.
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

describe("admittingRecipeLineWriter", () => {
	it("writes a row whose source is permitted and refuses rendered-gb before its row reaches the sink", async () => {
		const register = await readAddressSourceRegister()

		const rights = createSourceRightsAdmission(register, await readCorpusSourceInputs(register), {
			context: "recipe locale",
		})

		const sink = recordingSink()
		const write = admittingRecipeLineWriter(createRecipeLineWriter(sink), rights)

		write('{"source":"rendered-fr","raw":"1 rue de la Paix"}')

		expect(() => write('{"source":"rendered-gb","raw":"1 High Street"}')).toThrow(
			/rendered-gb reads register source gb-property-building-1/
		)

		expect(sink.chunks.join("")).toBe('{"source":"rendered-fr","raw":"1 rue de la Paix"}\n')
	})

	it("refuses a row carrying no source, since its rights cannot be read", async () => {
		const register = await readAddressSourceRegister()

		const rights = createSourceRightsAdmission(register, await readCorpusSourceInputs(register), {
			context: "recipe x",
		})

		expect(() => admittingRecipeLineWriter(createRecipeLineWriter(recordingSink()), rights)('{"raw":"x"}')).toThrow(
			/no string `source`/
		)
	})
})
