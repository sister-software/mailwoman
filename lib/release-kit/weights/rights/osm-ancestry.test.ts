/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A package whose model descends from OpenStreetMap data must say so in its own card and README. The
 *   fixtures build a base whose effective training manifest records an OpenStreetMap source and an overlay over
 *   it that declares no OpenStreetMap entry, which the audit refuses even though the overlay sampled no
 *   OpenStreetMap row. The committed tree's en-us card, which trained on OpenStreetMap extracts, passes.
 */

import { temporaryDirectory, type TemporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { repoRootPath } from "@mailwoman/core/paths"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openStreetMapAttributionRefusals, readOpenStreetMapAncestry } from "#release-kit/weights/rights/osm-ancestry"
import { readWeightsRightsRecords } from "#release-kit/weights/rights/record"
import { weightsRightsRecords } from "#release-kit/weights/rights/write"

const OSM_ENTRY =
	"OpenStreetMap contributors (ODbL-1.0): the `osm-ru` training extract. © OpenStreetMap contributors, https://www.openstreetmap.org/copyright."

const OSM_README =
	"# Fixture\n\n> © OpenStreetMap contributors. Data licensed under the Open Database License (ODbL) 1.0.\n"

const BASE = "packages/neural-weights-base"
const OVERLAY = "packages/neural-weights-overlay"

let scratch: TemporaryDirectory

beforeEach(async () => {
	scratch = await temporaryDirectory("osm-ancestry-")
})

afterEach(() => scratch[Symbol.asyncDispose]())

interface FixturePackage {
	workspace: string
	name: string
	baseWeights?: string
	card: Record<string, unknown>
	readme: string
}

/**
 * One effective manifest under the fixture root, with the source rows the ancestry reader inspects.
 */
async function writeEffectiveManifest(
	corpusVersion: string,
	sources: Array<{ source: string; license: string; emittedRows: number }>
): Promise<void> {
	await writeLocalJSONFile(
		{
			corpusVersion,
			sources,
			trainingSources: sources.filter((row) => row.emittedRows > 0).map((row) => row.source),
			requiredAttributions: [],
		},
		scratch.path("packages/corpus/data/training-manifests", `${corpusVersion}.effective.json`)
	)
}

async function writePackage(fixture: FixturePackage): Promise<void> {
	await writeLocalJSONFile(
		{
			name: fixture.name,
			version: "1.0.0",
			license: "AGPL-3.0-only",
			files: ["README.md", "LICENSE.md", "PROVENANCE.json", "model-card.json"],
			...(fixture.baseWeights ? { mailwoman: { baseWeights: fixture.baseWeights } } : {}),
		},
		scratch.path(fixture.workspace, "package.json")
	)

	await writeLocalJSONFile(fixture.card, scratch.path(fixture.workspace, "model-card.json"))
	await writeLocalTextFile(fixture.readme, scratch.path(fixture.workspace, "README.md"))
}

async function refusalsFor(...workspaces: string[]): Promise<string[]> {
	const records = await readWeightsRightsRecords(scratch.path, workspaces)

	return openStreetMapAttributionRefusals(await readOpenStreetMapAncestry(scratch.path, records))
}

const osmTrainedBase: FixturePackage = {
	workspace: BASE,
	name: "@fixture/neural-weights-base",
	card: { version: "1.0.0", training: { corpus_version: "fixture-osm", data_attribution: [OSM_ENTRY] } },
	readme: OSM_README,
}

describe("openStreetMapAttributionRefusals", () => {
	it("refuses an overlay that declares no OpenStreetMap entry over an OpenStreetMap-trained base", async () => {
		await writeEffectiveManifest("fixture-osm", [
			{ source: "osm-ru", license: "ODbL-1.0", emittedRows: 52_876 },
			{ source: "gnaf", license: "CC-BY-4.0", emittedRows: 1000 },
		])

		await writePackage(osmTrainedBase)

		await writePackage({
			workspace: OVERLAY,
			name: "@fixture/neural-weights-overlay",
			baseWeights: "@fixture/neural-weights-base",
			card: { version: "1.0.0" },
			readme: "# Overlay\n",
		})

		const refusals = await refusalsFor(BASE, OVERLAY)

		expect(refusals).toHaveLength(2)

		expect(refusals[0]).toMatch(
			/^@fixture\/neural-weights-overlay: it decodes through @fixture\/neural-weights-base, and its effective training manifest records osm-ru, and its model card's attribution has no OpenStreetMap entry/u
		)

		expect(refusals[1]).toMatch(/^@fixture\/neural-weights-overlay: .* its README does not state/u)
	})

	it("refuses an overlay over a base whose card attributes OpenStreetMap and names no corpus", async () => {
		await writePackage({ ...osmTrainedBase, card: { version: "1.0.0", attribution: [OSM_ENTRY] } })

		await writePackage({
			workspace: OVERLAY,
			name: "@fixture/neural-weights-overlay",
			baseWeights: "@fixture/neural-weights-base",
			card: { version: "1.0.0" },
			readme: OSM_README,
		})

		await expect(refusalsFor(BASE, OVERLAY)).resolves.toEqual([
			"@fixture/neural-weights-overlay: it decodes through @fixture/neural-weights-base, and its model card " +
				"attributes OpenStreetMap, and its model card's attribution has no OpenStreetMap entry naming ODbL.",
		])
	})

	it("refuses a graph package whose own corpus drew a rendered OpenStreetMap register and whose card omits the entry", async () => {
		await writeEffectiveManifest("fixture-rendered", [
			{ source: "rendered-pk-register", license: "ODbL-1.0", emittedRows: 10_751 },
		])

		await writePackage({
			...osmTrainedBase,
			card: { version: "1.0.0", training: { corpus_version: "fixture-rendered", data_attribution: [] } },
		})

		await expect(refusalsFor(BASE)).resolves.toEqual([
			"@fixture/neural-weights-base: its effective training manifest records rendered-pk-register, and its " +
				"model card's attribution has no OpenStreetMap entry naming ODbL.",
		])
	})

	it("passes an overlay that carries the entry and the README statement", async () => {
		await writeEffectiveManifest("fixture-osm", [{ source: "osm-ru", license: "ODbL-1.0", emittedRows: 52_876 }])
		await writePackage(osmTrainedBase)

		await writePackage({
			workspace: OVERLAY,
			name: "@fixture/neural-weights-overlay",
			baseWeights: "@fixture/neural-weights-base",
			card: { version: "1.0.0", attribution: [OSM_ENTRY] },
			readme: OSM_README,
		})

		await expect(refusalsFor(BASE, OVERLAY)).resolves.toEqual([])
	})

	it("asks nothing of a package whose lineage records no OpenStreetMap source", async () => {
		// A source the epoch drew zero rows from did not reach the trainer.
		await writeEffectiveManifest("fixture-clean", [
			{ source: "osm", license: "ODbL-1.0", emittedRows: 0 },
			{ source: "gnaf", license: "CC-BY-4.0", emittedRows: 1000 },
		])

		await writePackage({
			...osmTrainedBase,
			card: { version: "1.0.0", training: { corpus_version: "fixture-clean" } },
			readme: "# Base\n",
		})

		await writePackage({
			workspace: OVERLAY,
			name: "@fixture/neural-weights-overlay",
			baseWeights: "@fixture/neural-weights-base",
			card: { version: "1.0.0" },
			readme: "# Overlay\n",
		})

		await expect(refusalsFor(BASE, OVERLAY)).resolves.toEqual([])
	})
})

describe("the committed tree", () => {
	it("passes the en-us card, which trained on OpenStreetMap extracts and says so", async () => {
		const records = await weightsRightsRecords(repoRootPath())
		const rows = await readOpenStreetMapAncestry(repoRootPath(), records)
		const enUS = rows.find((row) => row.package === "@mailwoman/neural-weights-en-us")

		expect(enUS?.ownSources).toEqual(expect.arrayContaining(["osm-ru", "rendered-pk-register", "rendered-bd-register"]))
		expect(enUS?.declaresAttribution).toBe(true)
		expect(enUS?.readmeCarriesNotice).toBe(true)
		expect(openStreetMapAttributionRefusals(rows.filter((row) => row === enUS))).toEqual([])
	})

	it("refuses no published weights package", async () => {
		const records = await weightsRightsRecords(repoRootPath())

		expect(openStreetMapAttributionRefusals(await readOpenStreetMapAncestry(repoRootPath(), records))).toEqual([])
	})
})
