/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The three readings a rights record must not make: a package with no recorded attribution read as a package
 *   with none to record, an artifact with no recorded digest read as a verified one, and an overlay's card version
 *   read as the version of the model it decodes through.
 *
 *   The fixtures are written to a scratch tree rather than read from the checkout, so the assertions state what the
 *   reader does rather than what twelve packages happen to hold today. One assertion over the real tree stays, because
 *   the cross-package case this reader exists to find is a real one.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { renderProvenance } from "@mailwoman/release-kit/weights/rights/files"
import {
	licenseNamedIn,
	readWeightsRightsRecords,
	roleForArtifact,
	usesStatedIn,
	VersionSeries,
} from "@mailwoman/release-kit/weights/rights/record"
import { weightsRightsRecords } from "@mailwoman/release-kit/weights/rights/write"
import { join, type PathBuilderLike } from "path-ts"
import { describe, expect, it } from "vitest"

interface Fixture {
	workspace: string
	manifest: object
	card?: object
}

async function treeWith(
	fixtures: readonly Fixture[]
): Promise<{ root: PathBuilderLike; dispose: () => Promise<void> }> {
	const directory = await temporaryDirectory("mw-rights-record-")

	for (const fixture of fixtures) {
		await makeDirectories(join(directory.path, fixture.workspace))
		await writeLocalJSONFile(fixture.manifest, join(directory.path, fixture.workspace, "package.json"))

		if (fixture.card) {
			await writeLocalJSONFile(fixture.card, join(directory.path, fixture.workspace, "model-card.json"))
		}
	}

	return { root: directory.path, dispose: async () => void (await directory[Symbol.asyncDispose]()) }
}

describe("licenseNamedIn", () => {
	it("reads the license out of the parenthetical the cards use", () => {
		expect(licenseNamedIn("LINZ-derived OpenAddresses NZ (CC-BY 4.0): the synth-nz-v2 extract")).toBe("CC-BY 4.0")
		expect(licenseNamedIn("HM Land Registry — Price Paid Data (OGL v3.0): the synth-gb-v1 extract")).toBe("OGL v3.0")
	})

	it("returns null for a parenthetical that describes access rather than a grant", () => {
		// The OA PL entry.
		// `public` states that the download costs nothing, which is not a license,
		// and reading it as one would turn the gap this record exists to report into an answer.
		expect(licenseNamedIn("OpenAddresses PL — GUGiK / PRG (public, BDOT-derived): tokenizer-splice text")).toBeNull()
	})

	it("returns null for an entry with no parenthetical at all", () => {
		expect(licenseNamedIn("See THIRD_PARTY_NOTICES.md for the standing attribution.")).toBeNull()
	})
})

describe("usesStatedIn", () => {
	it("reads an entry describing a training extract as training", () => {
		expect(usesStatedIn("LINZ-derived OpenAddresses NZ (CC-BY 4.0): the `synth-nz-v2` training extract")).toEqual([
			"training",
		])
	})

	it("reads an entry describing only an evaluation set as evaluation", () => {
		// `en-us` carries two of these.
		// Reading them as training attribution says the model learned from rows it never saw,
		// and dropping them loses an attribution the source still requires.
		expect(
			usesStatedIn("OpenAddresses SI — GURS (CC-BY per OA source): oa-si coord eval set (free-rider validation)")
		).toEqual(["evaluation"])
	})

	it("reads both uses from an entry that states both", () => {
		expect(
			usesStatedIn(
				"OpenAddresses CZ — ČÚZK RÚIAN (CC-BY 4.0): tokenizer-splice training text + the oa-cz coord eval sets"
			)
		).toEqual(["tokenizer", "evaluation"])
	})

	it("reads an entry that states no use as unstated rather than as training", () => {
		// Defaulting to training would turn every entry whose wording this does not
		// recognize into a claim about what the model learned from.
		expect(
			usesStatedIn("See THIRD_PARTY_NOTICES.md for the standing OpenAddresses / GeoNames / WOF attribution.")
		).toEqual(["unstated"])
	})
})

describe("roleForArtifact", () => {
	it("gives each shipped filename the lineage class it carries", () => {
		// One `files` array holds artifacts with unrelated provenance.
		// The model graph carries a training corpus, the tokenizer carries the text it
		// was fitted on, and a pair index carries one named register.
		expect(roleForArtifact("model.onnx")).toBe("model-graph")
		expect(roleForArtifact("tokenizer.model")).toBe("tokenizer")
		expect(roleForArtifact("char-vocab.json")).toBe("character-vocabulary")
		expect(roleForArtifact("pair-index-gb.bin")).toBe("placetype-pair-index")
		expect(roleForArtifact("postcode-us.bin")).toBe("postcode-binary")
		expect(roleForArtifact("fst-en-gb.bin")).toBe("gazetteer-fst")
		expect(roleForArtifact("street-type-lexicon-v3.json")).toBe("lexicon")
		expect(roleForArtifact("calibration-per-locale.json")).toBe("calibration")
	})

	it("reads an unrecognized filename as other rather than guessing it into a role", () => {
		expect(roleForArtifact("something-new.bin")).toBe("other")
	})
})

describe("readWeightsRightsRecords", () => {
	it("records an undigested artifact as unrecorded rather than as verified", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-fixture",
				manifest: {
					name: "@mailwoman/neural-weights-fixture",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx", "fst-fixture.bin", "README.md", "**/*.ts"],
				},
				card: { version: "1.2.3", files_md5: { "model.onnx": "abc123" } },
			},
		])

		try {
			const [record] = await readWeightsRightsRecords(tree.root, ["packages/neural-weights-fixture"])

			// README.md documents the package, so it is not an artifact whose provenance is in question.
			// The glob is not a literal entry at all.
			expect(record!.artifacts.map((artifact) => artifact.path)).toEqual(["model.onnx", "fst-fixture.bin"])
			expect(record!.artifacts.map((artifact) => artifact.digest)).toEqual(["recorded", "unrecorded"])

			const document = renderProvenance(record!)

			expect(document.unresolved.some((line) => line.includes("fst-fixture.bin"))).toBe(true)
			expect(document.artifacts.find((artifact) => artifact.path === "fst-fixture.bin")?.md5).toBeNull()
		} finally {
			await tree.dispose()
		}
	})

	it("says a card records no attribution rather than that the package has none", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-fixture",
				manifest: {
					name: "@mailwoman/neural-weights-fixture",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["fst-fixture.bin"],
				},
				card: { version: "1.2.3" },
			},
		])

		try {
			const [record] = await readWeightsRightsRecords(tree.root, ["packages/neural-weights-fixture"])
			const document = renderProvenance(record!)

			expect(document.training_attribution.status).toBe("none-recorded-in-this-package")
			expect(document.unresolved.some((line) => line.includes("records no training attribution"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})

	it("carries the base's attribution to an overlay without making it the overlay's own", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: {
					version: "9.1.0",
					training: { data_attribution: ["Some Registry (OGL v3.0): the rows this graph trained on."] },
				},
			},
			{
				workspace: "packages/neural-weights-overlay",
				manifest: {
					name: "@mailwoman/neural-weights-overlay",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["pair-index.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-graph" },
				},
				card: { version: "6.5.0" },
			},
		])

		try {
			const records = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-graph",
				"packages/neural-weights-overlay",
			])

			const overlay = records[1]!

			// The overlay ships no graph and contributed none of those rows.
			// Its own attribution stays empty, and the base's travels under a field that says whose it is.
			// The distinction that keeps a record from claiming the overlay's locale trained the encoder.
			expect(overlay.attribution).toEqual([])
			expect(overlay.inherited?.package).toBe("@mailwoman/neural-weights-graph")
			expect(overlay.inherited?.packageVersion).toBe("10.0.0")
			expect(overlay.inherited?.modelCardVersion).toBe("9.1.0")
			expect(overlay.inherited?.attribution.map((entry) => entry.licenseNamed)).toEqual(["OGL v3.0"])
			expect(overlay.inherited?.unresolved).toBeNull()

			const document = renderProvenance(overlay)

			expect(document.training_attribution.status).toBe("none-recorded-in-this-package")
			expect(document.inherited_lineage?.attribution).toHaveLength(1)
			expect(document.inherited_lineage?.note).toContain("contributed none of these rows")

			// A graph package inherits nothing.
			expect(records[0]!.inherited).toBeNull()
		} finally {
			await tree.dispose()
		}
	})

	it("reports a base outside the set as unresolved rather than as an empty lineage", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-overlay",
				manifest: {
					name: "@mailwoman/neural-weights-overlay",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["pair-index.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-absent" },
				},
				card: { version: "6.5.0" },
			},
		])

		try {
			const [record] = await readWeightsRightsRecords(tree.root, ["packages/neural-weights-overlay"])

			expect(record!.inherited?.attribution).toEqual([])
			expect(record!.inherited?.unresolved).toMatch(/not among the packages read/)
			expect(renderProvenance(record!).unresolved.some((line) => line.includes("could not be resolved"))).toBe(true)
		} finally {
			await tree.dispose()
		}
	})

	it("stops on a base chain that returns to a package it already walked", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-a",
				manifest: {
					name: "@mailwoman/neural-weights-a",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["a.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-b" },
				},
				card: { version: "1.0.0" },
			},
			{
				workspace: "packages/neural-weights-b",
				manifest: {
					name: "@mailwoman/neural-weights-b",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["b.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-a" },
				},
				card: { version: "1.0.0" },
			},
		])

		try {
			const records = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-a",
				"packages/neural-weights-b",
			])

			expect(records[0]!.inherited?.unresolved).toMatch(/returns to/)
			expect(records[0]!.inherited?.attribution).toEqual([])
		} finally {
			await tree.dispose()
		}
	})

	it("separates an overlay's version series from a graph package's", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: { version: "9.1.0" },
			},
			{
				workspace: "packages/neural-weights-overlay",
				manifest: {
					name: "@mailwoman/neural-weights-overlay",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["pair-index.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-graph" },
				},
				card: { version: "6.5.0" },
			},
		])

		try {
			const records = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-graph",
				"packages/neural-weights-overlay",
			])

			expect(records[0]!.versionSeries).toBe(VersionSeries.Model)
			expect(records[0]!.baseWeights).toBeNull()
			expect(records[1]!.versionSeries).toBe(VersionSeries.Overlay)
			expect(records[1]!.baseWeights).toBe("@mailwoman/neural-weights-graph")

			// The overlay's own number.
			// Reading the graph's 9.1.0 here would state that this package ships the suffix-boundary model.
			expect(renderProvenance(records[1]!).model_card_version).toBe("6.5.0")
		} finally {
			await tree.dispose()
		}
	})

	it("finds an artifact whose attribution sits in another package's card", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: {
					version: "9.1.0",
					training: { data_attribution: ["Some Registry (OGL v3.0): the pair-index-gb.bin index."] },
				},
			},
			{
				workspace: "packages/neural-weights-overlay",
				manifest: {
					name: "@mailwoman/neural-weights-overlay",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["pair-index-gb.bin"],
					mailwoman: { baseWeights: "@mailwoman/neural-weights-graph" },
				},
				card: { version: "6.5.0" },
			},
		])

		try {
			const records = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-graph",
				"packages/neural-weights-overlay",
			])

			expect(records[1]!.foreignAttribution).toEqual([
				{
					artifact: "pair-index-gb.bin",
					recordedIn: "@mailwoman/neural-weights-graph",
					text: "Some Registry (OGL v3.0): the pair-index-gb.bin index.",
				},
			])
		} finally {
			await tree.dispose()
		}
	})
})

describe("the records this repository holds today", () => {
	it("covers twelve published weights packages, each attributing the artifacts it ships", async () => {
		const records = await weightsRightsRecords(repoRootPath())

		expect(records).toHaveLength(12)

		// `pair-index-gb.bin` ships here, and its OGL v3.0 attribution used to sit in `en-us`'s card,
		// so a consumer who installed the overlay alone received the artifact without it.
		// The entry now travels with the artifact.
		const gb = records.find((record) => record.packageName === "@mailwoman/neural-weights-en-gb")

		expect(gb?.attribution.map((entry) => entry.licenseNamed)).toEqual(["OGL v3.0"])
		expect(gb?.attribution[0]?.text).toContain("pair-index-gb.bin")
	})

	it("reports no artifact whose attribution sits in another package's card", async () => {
		const records = await weightsRightsRecords(repoRootPath())

		const foreign = records.flatMap((record) =>
			record.foreignAttribution.map((entry) => `${entry.artifact} ships in ${record.packageName}`)
		)

		expect(foreign).toEqual([])
	})
})
