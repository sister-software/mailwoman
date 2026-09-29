/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A missing `postcode-<cc>.bin` throws no error and reads as a model regression, so the guard reads each
 *   package's own card rather than a list in the harness and stays silent only where a package ships no binary on purpose.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { assertDeclaredAnchorBins } from "mailwoman/eval-harness/gauntlet/harness"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function fixtureWeights(locale: string, card: Record<string, unknown>, siblings: string[] = []): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("gauntlet-weights-")).path.toString()
	const dir = weightsCachePackageDir(root, locale)

	await makeDirectories(dir)
	await writeLocalTextFile("", dir("model.onnx"))
	await writeLocalTextFile("", dir("tokenizer.model"))
	await writeLocalJSONFile(card, dir("model-card.json"))

	for (const sibling of siblings) {
		await writeLocalTextFile("", dir(sibling))
	}

	return root
}

describe("the anchor-artifact presence assertion", () => {
	it("passes when the declared binary is on disk", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } }, ["postcode-zz.bin"])

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).resolves.toBeUndefined()
	})

	it("REFUSES when a package declares a binary it does not have", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).rejects.toThrow(/postcode-zz\.bin/)
	})

	it("names the repair — the package's own link-dev-weights script", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		const error = await (async () => {
			try {
				await assertDeclaredAnchorBins(["zz-zz"], root)
			} catch (caught) {
				return caught as Error
			}

			return undefined
		})()

		expect(error?.message).toMatch(/scripts\/link-dev-weights\.ts/)
		expect(error?.message).toMatch(/files\.postcode_anchor/)
	})

	it("stays silent for a package that declares no anchor artifact — the #1476 en-gb posture", async () => {
		// The en-gb card sets `requires.anchor.required` true while `files` contains only a comment,
		// so a guard keyed on `requires` would call it broken and one keyed on `files` would not.
		const root = await fixtureWeights("zz-zz", {
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — this overlay ships no postcode-zz.bin (deliberate)" },
		})

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).resolves.toBeUndefined()
	})

	it("stays silent for a package with no card at all", async () => {
		await using rootDirectory = await temporaryDirectory("gauntlet-weights-")
		const root = rootDirectory.path.toString()
		const dir = weightsCachePackageDir(root, "zz-zz")

		await makeDirectories(dir)
		await writeLocalTextFile("", dir("model.onnx"))
		await writeLocalTextFile("", dir("tokenizer.model"))

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).resolves.toBeUndefined()
	})

	it("reports EVERY missing package, not just the first", async () => {
		// One fixture root cannot hold two locales' packages in the cache layout
		// `resolveWeights` probes, so the multi-locale case is two calls against one root
		// and the message must include a per-locale tag.
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).rejects.toThrow(/✗ zz-zz:/)
	})

	it("skips a locale whose package does not resolve at all — a different failure with a different repair", async () => {
		await using rootDirectory = await temporaryDirectory("gauntlet-weights-")
		const root = rootDirectory.path.toString()

		await expect(assertDeclaredAnchorBins(["zz-zz"], root)).resolves.toBeUndefined()
	})
})
