import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { createSymbolicLink, writeLocalTextFile, writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { workspacePath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

import { readDeclaredArtifactFile, unfedAnchorDetail } from "#weights/channels"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

async function packageDir(card?: unknown, siblings: string[] = []): Promise<PathBuilder> {
	const dir = fixtures.use(await temporaryDirectory("weights-card-")).path

	await makeDirectories(dir)

	if (card) {
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

		await expect(readDeclaredArtifactFile(await dir)).resolves.toMatchObject({
			key: "postcode_anchor",
			file: "postcode-us.bin",
			present: true,
		})
	})

	it("Reports a declared artifact that is absent — the case the whole condition exists for", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } })

		await expect(readDeclaredArtifactFile(await dir)).resolves.toMatchObject({
			file: "postcode-us.bin",
			present: false,
		})
	})

	it("reports a declared artifact present when the package directory is a symbolic link, as a staged cache holds it", async () => {
		const real = await packageDir({ files: { postcode_anchor: "postcode-us.bin" } }, ["postcode-us.bin"])
		const cache = fixtures.use(await temporaryDirectory("weights-cache-")).path
		const linked = cache("node_modules", "@mailwoman", "neural-weights-en-us")

		await createSymbolicLink(real, linked, "dir")

		await expect(readDeclaredArtifactFile(linked)).resolves.toMatchObject({ file: "postcode-us.bin", present: true })
		await expect(unfedAnchorDetail(linked)).resolves.toMatch(/parsed EMPTY/)
	})

	it("Prefers the PCB1 binary over the legacy JSON lookup when a card names both", async () => {
		const dir = packageDir({ files: { anchor_lookup: "anchor-lookup.json", postcode_anchor: "postcode-us.bin" } })

		expect((await readDeclaredArtifactFile(await dir))?.key).toBe("postcode_anchor")
	})

	it("Falls back to the legacy JSON lookup when that is all the card names", async () => {
		const dir = packageDir({ files: { anchor_lookup: "anchor-lookup.json" } }, ["anchor-lookup.json"])

		await expect(readDeclaredArtifactFile(await dir)).resolves.toMatchObject({ key: "anchor_lookup", present: true })
	})

	it("does NOT read a $comment_ sibling as a declaration (en-gb's documented absence)", async () => {
		const dir = packageDir({
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — this overlay ships no postcode-gb.bin (deliberate)" },
		})

		await expect(readDeclaredArtifactFile(await dir)).resolves.toBeNull()
	})

	it("Returns null for a card with neither files block nor card without dir, and a corrupt card", async () => {
		await expect(
			readDeclaredArtifactFile(await packageDir({ requires: { anchor: { required: true } } }))
		).resolves.toBeNull()

		await expect(readDeclaredArtifactFile(await packageDir())).resolves.toBeNull()
		await expect(readDeclaredArtifactFile(null)).resolves.toBeNull()
		await expect(readDeclaredArtifactFile(await packageDir("{not json"))).resolves.toBeNull()
	})

	it("ignores a files entry that is not a filename", async () => {
		await expect(readDeclaredArtifactFile(await packageDir({ files: { postcode_anchor: "" } }))).resolves.toBeNull()
		await expect(readDeclaredArtifactFile(await packageDir({ files: { postcode_anchor: 3 } }))).resolves.toBeNull()
		await expect(readDeclaredArtifactFile(await packageDir({ files: ["postcode-us.bin"] }))).resolves.toBeNull()
	})

	it("reads the SHIPPED cards: en-us/fr-fr/en-gb declare their binaries, en-nz declares none", async () => {
		await expect(readDeclaredArtifactFile(workspacePath("neural-weights-en-us"))).resolves.toMatchObject({
			file: "postcode-us.bin",
		})

		await expect(readDeclaredArtifactFile(workspacePath("neural-weights-fr-fr"))).resolves.toMatchObject({
			file: "postcode-fr.bin",
		})

		await expect(readDeclaredArtifactFile(workspacePath("neural-weights-en-gb"))).resolves.toMatchObject({
			file: "postcode-gb.bin",
		})

		await expect(readDeclaredArtifactFile(workspacePath("neural-weights-en-nz"))).resolves.toBeNull()
	})
})

describe("unfedAnchorDetail — whether an unfed anchor channel is worth a warning", () => {
	it("speaks when the package declares a binary it does not have", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } })

		await expect(unfedAnchorDetail(await dir)).resolves.toMatch(
			/declares files\.postcode_anchor = postcode-us\.bin, which is NOT in/
		)
	})

	it("speaks when the declared binary is present but parsed empty — the other broken-package shape", async () => {
		const dir = packageDir({ files: { postcode_anchor: "postcode-us.bin" } }, ["postcode-us.bin"])

		await expect(unfedAnchorDetail(await dir)).resolves.toMatch(/parsed EMPTY/)
	})

	it("Stays SILENT for a package that declares no binary — the false alarm", async () => {
		const dir = packageDir({
			requires: { anchor: { required: true } },
			files: { $comment_postcode_anchor: "NONE — deliberate" },
		})

		await expect(unfedAnchorDetail(await dir)).resolves.toBeNull()
		await expect(unfedAnchorDetail(null)).resolves.toBeNull()
	})
})
