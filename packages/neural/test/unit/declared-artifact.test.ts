/**
 * @copyright Sister Software.
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `readDeclaredArtifactFile` — what a weights package's OWN card says it ships, and whether it does.
 *
 *   This reader decides whether an unfed anchor channel is a broken package or a supported posture (#1516), so
 *   its tail matters more than its happy path: the shipped cards keep `$comment_*` siblings inside `files` to
 *   record a DELIBERATE absence, and reading one of those as a filename would turn en-gb's documented
 *   mitigation into a hard failure at every load.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { workspacePath } from "@mailwoman/core/utils"
import { readDeclaredArtifactFile, unfedAnchorDetail } from "@mailwoman/neural/weights-channels"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function packageDir(card?: unknown, siblings: string[] = []): Promise<string> {
	const dir = resolvePath(fixtures.use(await temporaryDirectory("weights-card-")).path)

	await makeDirectories(dir)

	if (card !== undefined) {
		await writeLocalFile(typeof card === "string" ? card : JSON.stringify(card), join(dir, "model-card.json"))
	}

	for (const sibling of siblings) {
		await writeLocalTextFile("", join(dir, sibling))
	}

	return dir
}

describe("readDeclaredArtifactFile", () => {
	it("reports a declared artifact that is present", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } }, ["postcode-us.bin"])

		expect(await readDeclaredArtifactFile(await dir)).toMatchObject({
			key: "postcode_anchor",
			file: "postcode-us.bin",
			present: true,
		})
	})

	it("reports a declared artifact that is absent — the case the whole guard exists for", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } })

		expect(await readDeclaredArtifactFile(await dir)).toMatchObject({ file: "postcode-us.bin", present: false })
	})

	it("prefers the PCB1 binary over the legacy JSON lookup when a card names both", async () => {
		const dir = packageDir({ files: { anchor_lookup: "anchor-lookup.json", postcode_anchor: "postcode-us.bin" } })

		expect((await readDeclaredArtifactFile(await dir))?.key).toBe("postcode_anchor")
	})

	it("falls back to the legacy JSON lookup when that is all the card names", async () => {
		const dir = packageDir({ files: { anchor_lookup: "anchor-lookup.json" } }, ["anchor-lookup.json"])

		expect(await readDeclaredArtifactFile(await dir)).toMatchObject({ key: "anchor_lookup", present: true })
	})

	it("does NOT read a $comment_ sibling as a declaration (en-gb's documented absence)", async () => {
		const dir = packageDir({
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — this overlay ships no postcode-gb.bin (deliberate)" },
		})

		expect(await readDeclaredArtifactFile(await dir)).toBeUndefined()
	})

	it("returns undefined for a card with no files block, no card, no dir, and a corrupt card", async () => {
		expect(
			await readDeclaredArtifactFile(await packageDir({ requires: { anchor: { required: true } } }))
		).toBeUndefined()

		expect(await readDeclaredArtifactFile(await packageDir())).toBeUndefined()
		expect(await readDeclaredArtifactFile(undefined)).toBeUndefined()
		expect(await readDeclaredArtifactFile(await packageDir("{not json"))).toBeUndefined()
	})

	it("ignores a files entry that is not a filename", async () => {
		expect(await readDeclaredArtifactFile(await packageDir({ files: { postcode_anchor: "" } }))).toBeUndefined()
		expect(await readDeclaredArtifactFile(await packageDir({ files: { postcode_anchor: 3 } }))).toBeUndefined()
		expect(await readDeclaredArtifactFile(await packageDir({ files: ["postcode-us.bin"] }))).toBeUndefined()
	})

	it("reads the SHIPPED cards: en-us/fr-fr/en-gb declare their binaries, en-nz declares none", async () => {
		// The two postures this reader must keep apart, against the real cards rather than fixtures — a card
		// edit that dropped either one would leave every fixture test above green. en-gb moved to the
		// declaring column 2026-08-06 (9.0.0, ROAD_TO_V9 A4): the v4.2.0 base trained the GB anchor slot,
		// so postcode-gb.bin returned — the #1467-era "declares none" posture now lives only on en-nz
		// (no NZ postcode shard exists).
		expect(await readDeclaredArtifactFile(workspacePath("neural-weights-en-us"))).toMatchObject({
			file: "postcode-us.bin",
		})

		expect(await readDeclaredArtifactFile(workspacePath("neural-weights-fr-fr"))).toMatchObject({
			file: "postcode-fr.bin",
		})

		expect(await readDeclaredArtifactFile(workspacePath("neural-weights-en-gb"))).toMatchObject({
			file: "postcode-gb.bin",
		})

		expect(await readDeclaredArtifactFile(workspacePath("neural-weights-en-nz"))).toBeUndefined()
	})
})

describe("unfedAnchorDetail — whether an unfed anchor channel is worth a warning", () => {
	it("speaks when the package declares a binary it does not have", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } })

		expect(await unfedAnchorDetail(await dir)).toMatch(
			/declares files\.postcode_anchor = postcode-us\.bin, which is NOT in/
		)
	})

	it("speaks when the declared binary is present but parsed empty — the other broken-package shape", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } }, ["postcode-us.bin"])

		expect(await unfedAnchorDetail(await dir)).toMatch(/parsed EMPTY/)
	})

	it("stays SILENT for a package that declares no binary — the #1516 false alarm", async () => {
		// en-gb's shape. Its card says `requires.anchor.required: true` (about the shared encoder) and ships no
		// binary on purpose, and the old condition read only the first half — so every process that loaded this
		// overlay printed an anchor-OFF warning naming no package, which an operator whose primary bin was
		// present and feeding could only read as being about the primary.
		const dir = packageDir({
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — deliberate" },
		})

		expect(await unfedAnchorDetail(await dir)).toBeUndefined()
		expect(await unfedAnchorDetail(undefined)).toBeUndefined()
	})
})
