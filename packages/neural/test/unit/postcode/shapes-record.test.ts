/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The postcode-shape record is read by two runtimes: this package's postcode repair, and the Python trainer, which
 *   paints the train-side anchor on the spans the repair finds. Held as two typed tables they drifted twice — the IE
 *   Eircode row was TypeScript-only for a month, the BR CEP row for five weeks — and each time the trainer painted one
 *   fewer shape than inference, with nothing failing.
 *
 *   The table is now data, authored once in `@mailwoman/codex`. The trainer cannot import that package (a Modal
 *   container receives only `corpus-python/src`), so it carries a byte-identical copy. The Python suite checks that
 *   copy against the authored one; this checks the same equality from the TypeScript side, so an edit made here is
 *   caught by `yarn test` rather than only by a suite somebody may not run.
 *
 *   It lives in this package, not in codex, because codex is deliberately zero-dependency and the check needs a repo
 *   root resolver. The consumer is the right home for a cross-language contract the consumer depends on.
 */

import { POSTCODE_SHAPES, POSTCODE_SHAPES_VERSION } from "@mailwoman/codex/postcode-shapes"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

const AUTHORED = repoRootPath("packages", "codex", "lib", "postcode-shapes.json")
const VENDORED = repoRootPath("corpus-python", "src", "mailwoman_train", "features", "postcode-shapes.json")

describe("the postcode shape record", () => {
	it("is vendored into the Python package byte for byte", async () => {
		const [authored, vendored] = await Promise.all([readLocalBuffer(AUTHORED), readLocalBuffer(VENDORED)])

		expect(
			vendored.equals(authored),
			`${VENDORED} has drifted from ${AUTHORED}. The codex copy is the authored one — copy it across rather ` +
				"than editing the Python side."
		).toBe(true)
	})

	it("compiles every shape, in the order the record declares", () => {
		expect(POSTCODE_SHAPES.length).toBeGreaterThanOrEqual(12)
		expect(POSTCODE_SHAPES_VERSION).toBe("postcode-shapes-v1")

		// Priority IS the index, so the catch-all has to stay last or it claims the spans the specific rows exist for.
		expect(POSTCODE_SHAPES.at(-1)?.label).toBe("NUM5")

		for (const shape of POSTCODE_SHAPES) {
			expect(shape.re.flags, `${shape.label} must scan the whole line`).toContain("g")
		}
	})

	it("finds the two shapes whose absence went unnoticed on the Python side", () => {
		const firstMatch = (label: string, text: string) => {
			const shape = POSTCODE_SHAPES.find((candidate) => candidate.label === label)

			expect(shape, `${label} is not in the record`).toBeDefined()

			return text.match(new RegExp(shape!.re.source, shape!.re.flags))?.[0]
		}

		expect(firstMatch("IE", "Ballinlough, T12 X70A, Cork")).toBe("T12 X70A")
		expect(firstMatch("BR", "Rua Ramiro Barcelos, Porto Alegre 95090-020")).toBe("95090-020")
	})
})
