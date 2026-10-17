/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Three distinctions a rights record must preserve. A package with no recorded attribution may still have attribution.
 *   An artifact with no recorded digest has no verified digest. An overlay's card version can differ from its base model version.
 *
 *   The fixtures are written to a scratch tree rather than read from the checkout, so the assertions state what the
 *   reader does rather than what twelve packages happen to hold today. One assertion over the real tree stays, because
 *   the cross-package case this reader exists to find is a real one.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { describe, expect, it } from "vitest"

import { renderLicenseFile, renderProvenance } from "#release-kit/weights/rights/files"
import {
	readWeightsRightsRecords,
	roleForArtifact,
	usesStatedIn,
	VersionSeries,
} from "#release-kit/weights/rights/record"
import { weightsRightsRecords } from "#release-kit/weights/rights/write"

interface Fixture {
	workspace: string
	manifest: object
	card?: object
}

async function treeWith(fixtures: readonly Fixture[]): Promise<{ root: PathBuilder; dispose: () => Promise<void> }> {
	const directory = await temporaryDirectory("mw-rights-record-")

	for (const fixture of fixtures) {
		await makeDirectories(directory.path(fixture.workspace))
		await writeLocalJSONFile(fixture.manifest, directory.path(fixture.workspace, "package.json"))

		if (fixture.card) {
			await writeLocalJSONFile(fixture.card, directory.path(fixture.workspace, "model-card.json"))
		}
	}

	return { root: directory.path, dispose: async () => void (await directory[Symbol.asyncDispose]()) }
}

describe("usesStatedIn", () => {
	it("reads an entry describing a training extract as training", () => {
		expect(usesStatedIn("LINZ-derived OpenAddresses NZ (CC-BY 4.0): the `synth-nz-v2` training extract")).toEqual([
			"training",
		])
	})

	it("reads an entry describing only an evaluation set as evaluation", () => {
		// `en-us` has two of these.
		// A training-attribution reading implies the model learned from rows it never saw.
		// Their removal loses attribution the source still requires.
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
		// A default training classification would turn every entry whose wording this does
		// not recognize into a claim about what the model learned from.
		expect(
			usesStatedIn("See THIRD_PARTY_NOTICES.md for the standing OpenAddresses / GeoNames / WOF attribution.")
		).toEqual(["unstated"])
	})
})

describe("roleForArtifact", () => {
	it("gives each shipped filename the lineage class it carries", () => {
		// One `files` array holds artifacts with unrelated provenance.
		// The model graph records a training corpus.
		// The tokenizer records the text used for fitting.
		// A pair index stores one selected register.
		expect(roleForArtifact("model.onnx")).toBe("model-graph")
		expect(roleForArtifact("tokenizer.model")).toBe("tokenizer")
		expect(roleForArtifact("char-vocab.json")).toBe("character-vocabulary")
		expect(roleForArtifact("pair-index-gb.bin")).toBe("placetype-pair-index")
		expect(roleForArtifact("postcode-us.bin")).toBe("postcode-binary")
		expect(roleForArtifact("postcode-prefix-us.bin")).toBe("postcode-prefix-index")
		expect(roleForArtifact("postcode-prefix-gb-esw.bin")).toBe("postcode-prefix-index")
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

	it("derives the required attributions from the committed effective training manifest and repeats them for an overlay", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: { version: "9.1.0", training: { corpus_version: "v0.0.0-fixture" } },
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

		const statement = "© OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0."

		await makeDirectories(tree.root("packages", "corpus", "data", "training-manifests"))

		await writeLocalJSONFile(
			{
				manifestID: "corpus-effective-training-manifest",
				schemaVersion: 2,
				drawEvidence: "replayed-epoch-audit",
				labelSet: null,
				requiredAttributions: [
					{ license: "CC-BY-4.0", sources: ["gnaf"], statement: null },
					{ license: "ODbL-1.0", sources: ["osm-in", "osm-ru"], statement },
				],
				corpusVersion: "v0.0.0-fixture",
				corpusManifestDigest: "digest",
				config: "configs/fixture.yaml",
				seed: 43,
				drawsRequested: 10,
				drawsRealized: 10,
				admittedCountries: 2,
				countriesDrawingRows: 2,
				admittedCountriesDrawingZero: [],
				sources: [],
				trainingSources: ["gnaf", "osm-in", "osm-ru"],
				excludedSources: {},
				emittedButUnrecorded: {},
				unrecordedSourceStages: {},
				totalEmittedRows: 10,
				contentDigest: "",
			},
			tree.root("packages", "corpus", "data", "training-manifests", "v0.0.0-fixture.effective.json")
		)

		try {
			const [graph, overlay] = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-graph",
				"packages/neural-weights-overlay",
			])

			const document = renderProvenance(graph!)

			expect(document.required_attributions).toEqual([
				{ license: "CC-BY-4.0", sources: ["gnaf"], statement: null },
				{ license: "ODbL-1.0", sources: ["osm-in", "osm-ru"], statement },
			])

			// The overlay has no manifest of its own, so its own field stays null while the
			// base's attributions reach a consumer who installs the overlay alone.
			const overlayDocument = renderProvenance(overlay!)

			expect(overlayDocument.required_attributions).toBeNull()

			expect(overlayDocument.inherited_lineage?.required_attributions.map((entry) => entry.license)).toEqual([
				"CC-BY-4.0",
				"ODbL-1.0",
			])

			const license = renderLicenseFile(graph!)

			expect(license).toContain("## Attribution the training data requires")
			expect(license).toContain(`- ${statement} (\`ODbL-1.0\`: osm-in, osm-ru)`)
			expect(license).toContain("- `CC-BY-4.0`: gnaf")

			expect(renderLicenseFile(overlay!)).toContain(
				"decodes through the model graph `@mailwoman/neural-weights-graph` ships"
			)
		} finally {
			await tree.dispose()
		}
	})

	it("says that no effective training manifest is committed rather than that no attribution is owed", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-fixture",
				manifest: {
					name: "@mailwoman/neural-weights-fixture",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: { version: "1.2.3", training: { corpus_version: "v0.0.0-unrecorded" } },
			},
		])

		try {
			const [record] = await readWeightsRightsRecords(tree.root, ["packages/neural-weights-fixture"])

			expect(renderProvenance(record!).required_attributions).toBeNull()
			expect(renderLicenseFile(record!)).toContain("No effective training manifest is committed for the corpus")
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
			// Its own attribution stays empty.
			// The base's attribution uses a field that identifies its owner.
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

			expect(records[0]!.inherited).toBeNull()
		} finally {
			await tree.dispose()
		}
	})

	it("prints a card's data-access offer and repeats it for an overlay of that graph", async () => {
		const offer = {
			license: "ODbL-1.0",
			provision: "ODbL 1.0 section 4.6(a)",
			sources: ["osm-fixture"],
			url: "https://example.org/extract",
			manifest_url: "https://example.org/extract/MANIFEST.json",
			statement: "The fixture extract",
		}

		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: { version: "9.1.0", training: { data_access_offers: [offer] } },
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
			const [graph, overlay] = await readWeightsRightsRecords(tree.root, [
				"packages/neural-weights-graph",
				"packages/neural-weights-overlay",
			])

			expect(renderProvenance(graph!).data_access_offers).toEqual([offer])
			expect(renderLicenseFile(graph!)).toContain("https://example.org/extract/MANIFEST.json")

			// The overlay's own card records no offer.
			// The offer it prints is the base's, under inherited_lineage.
			expect(renderProvenance(overlay!).data_access_offers).toEqual([])
			expect(renderProvenance(overlay!).inherited_lineage?.data_access_offers).toEqual([offer])
			expect(renderLicenseFile(overlay!)).toContain("## Access to the training data")
		} finally {
			await tree.dispose()
		}
	})

	it("refuses an offer missing a field rather than printing no offer", async () => {
		const tree = await treeWith([
			{
				workspace: "packages/neural-weights-graph",
				manifest: {
					name: "@mailwoman/neural-weights-graph",
					version: "10.0.0",
					license: "AGPL-3.0-only OR LicenseRef-Commercial",
					files: ["model.onnx"],
				},
				card: { version: "9.1.0", training: { data_access_offers: [{ license: "ODbL-1.0", sources: ["osm"] }] } },
			},
		])

		try {
			await expect(readWeightsRightsRecords(tree.root, ["packages/neural-weights-graph"])).rejects.toThrow(
				/data_access_offers\[0\]\.provision/
			)
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
			// The graph's 9.1.0 here would state that this package ships the suffix-boundary model.
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

		// `pair-index-gb.bin` ships here with its OGL v3.0 attribution, so a consumer who
		// installs only the overlay receives the attribution with the artifact.
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
