import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import { readDeclaredArtifactFile, unfedAnchorDetail } from "@mailwoman/neural/weights-channels"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function packageDir(card?: unknown, siblings: string[] = []): Promise<PathBuilder> {
	const dir = fixtures.use(await temporaryDirectory("weights-card-")).path

	await makeDirectories(dir)

	if (card !== undefined) {
		await writeLocalFile(typeof card === "string" ? card : stringifyJSON(card), dir("model-card.json"))
	}

	for (const sibling of siblings) {
		await writeLocalTextFile("", dir(sibling))
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

	it("Reports a declared artifact that is absent — the case the whole condition exists for", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } })

		expect(await readDeclaredArtifactFile(await dir)).toMatchObject({ file: "postcode-us.bin", present: false })
	})

	it("Prefers the PCB1 binary over the legacy JSON lookup when a card names both", async () => {
		const dir = packageDir({ files: { anchor_lookup: "anchor-lookup.json", postcode_anchor: "postcode-us.bin" } })

		expect((await readDeclaredArtifactFile(await dir))?.key).toBe("postcode_anchor")
	})

	it("Falls back to the legacy JSON lookup when that is all the card names", async () => {
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

	it("Returns undefined for a card with neither files block nor card without dir, and a corrupt card", async () => {
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

	it("Stays SILENT for a package that declares no binary — the false alarm", async () => {
		const dir = packageDir({
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — deliberate" },
		})

		expect(await unfedAnchorDetail(await dir)).toBeUndefined()
		expect(await unfedAnchorDetail(undefined)).toBeUndefined()
	})
})
