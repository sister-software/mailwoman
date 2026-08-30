/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The grading environment's artifact-presence contract (#1516, second half).
 *
 *   The failure being guarded is silent by construction: a weights package missing its `postcode-<cc>.bin`
 *   throws nothing, resolves the anchor channel OFF, and costs the run 3-4 baseline cases — which reads as a
 *   model regression. The guard must fire on THAT, and must stay quiet for the packages that ship no binary on
 *   purpose (en-gb under the #1476 mitigation, en-nz for want of a WOF NZ postcode shard), which is why the
 *   expectation is read from each package's own card instead of a list in the harness.
 *
 *   Fixture packages, not the workspace ones: "declared and missing" cannot be posed against the real
 *   neural-weights-* dirs without deleting an artifact out from under every other test in the run.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { weightsCachePackageDir } from "@mailwoman/neural/weights"
import { join } from "@mailwoman/platform/path"
import { assertDeclaredAnchorBins } from "mailwoman/eval-harness/gauntlet/harness"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Lay out `<root>/node_modules/@mailwoman/neural-weights-<locale>` with the two binaries `resolveWeights` probes for,
 * the given card, and whichever sibling artifacts the case wants present.
 */
async function fixtureWeights(locale: string, card: Record<string, unknown>, siblings: string[] = []): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("gauntlet-weights-")).path
	const dir = weightsCachePackageDir(root, locale)

	await makeDirectories(dir)
	await writeLocalTextFile("", join(dir, "model.onnx"))
	await writeLocalTextFile("", join(dir, "tokenizer.model"))
	await writeLocalJSONFile(card, join(dir, "model-card.json"))

	for (const sibling of siblings) {
		await writeLocalTextFile("", join(dir, sibling))
	}

	return root
}

describe("the anchor-artifact presence assertion", () => {
	it("passes when the declared binary is on disk", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } }, ["postcode-zz.bin"])

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).not.toThrow()
	})

	it("REFUSES when a package declares a binary it does not have", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).toThrow(/postcode-zz\.bin/)
	})

	it("names the repair — the package's own link-dev-weights script", async () => {
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		const error = (() => {
			try {
				assertDeclaredAnchorBins(["zz-zz"], root)
			} catch (caught) {
				return caught as Error
			}

			return undefined
		})()

		expect(error?.message).toMatch(/scripts\/link-dev-weights\.ts/)
		expect(error?.message).toMatch(/files\.postcode_anchor/)
	})

	it("stays silent for a package that declares no anchor artifact — the #1476 en-gb posture", async () => {
		// Verbatim shape of the en-gb card: `requires.anchor.required` is TRUE (a fact about the shared encoder)
		// while `files` carries only a comment where the binary key would be. A guard keyed on `requires` calls
		// this broken; a guard keyed on `files` calls it what it is.
		const root = await fixtureWeights("zz-zz", {
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — this overlay ships no postcode-zz.bin (deliberate)" },
		})

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).not.toThrow()
	})

	it("stays silent for a package with no card at all", async () => {
		await using rootDirectory = await temporaryDirectory("gauntlet-weights-")
		const root = rootDirectory.path
		const dir = weightsCachePackageDir(root, "zz-zz")

		await makeDirectories(dir)
		await writeLocalTextFile("", join(dir, "model.onnx"))
		await writeLocalTextFile("", join(dir, "tokenizer.model"))

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).not.toThrow()
	})

	it("reports EVERY missing package, not just the first", async () => {
		// One fixture root cannot hold two locales' packages under the cache layout `resolveWeights` probes, so
		// the multi-locale case is posed as two calls against the same root — what matters is that the message
		// is per-locale and carries the locale tag, which is what makes a six-overlay run diagnosable.
		const root = await fixtureWeights("zz-zz", { files: { postcode_anchor: "postcode-zz.bin" } })

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).toThrow(/✗ zz-zz:/)
	})

	it("skips a locale whose package does not resolve at all — a different failure with a different repair", async () => {
		await using rootDirectory = await temporaryDirectory("gauntlet-weights-")
		const root = rootDirectory.path

		expect(() => assertDeclaredAnchorBins(["zz-zz"], root)).not.toThrow()
	})
})
