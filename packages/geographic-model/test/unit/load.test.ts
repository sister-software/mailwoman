/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authoring loader: that a directory's layout is convenience and nothing else, and that a
 *   failure names the file an author can open.
 *
 *   The enumeration property is tested against a permuted FILE LIST rather than against a real
 *   directory, on purpose. `readdir` order is a property of the filesystem — hash order on ext4, and
 *   not something a test can arrange — so a test that wrote files in an awkward order would be
 *   asserting about the machine it ran on. Handing the merge its files in reverse states the property
 *   directly: any order, one answer. The temporary-directory case below then checks that the
 *   directory path produces that same answer twice.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/objects"
import { compileGeographicModel, serializeCompiledModel, ValidationIssueCode } from "@mailwoman/geographic-model"
import {
	type GeographicModelSourceFile,
	GeographicModelLoadError,
	loadGeographicModelDirectory,
	LoadIssueCode,
	mergeGeographicModelFiles,
	MODEL_MANIFEST_FILENAME,
} from "@mailwoman/geographic-model/load"
import { resolve } from "@mailwoman/platform/path"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

const manifest = { version: "0.1.0" }

const provenance = { source: "mailwoman-curated", authoredAt: "2026-08-26" }

const relations = {
	relations: [
		{
			id: "affords",
			label: "affords",
			description: "The establishment class makes the activity available to a person who goes there.",
			domainKinds: ["establishment"],
			rangeKinds: ["activity"],
			transitive: false,
			symmetric: false,
			semantics: "defeasible",
		},
	],
}

const activities = {
	concepts: [
		{
			id: "obtain_medication",
			label: "obtaining medication",
			description: "The activity of obtaining medication.",
			kind: "activity",
			isA: [],
			assertions: [],
			provenance,
			status: "active",
		},
	],
}

const establishments = {
	concepts: [
		{
			id: "pharmacy",
			label: "pharmacy",
			description: "Premises dispensing medication.",
			kind: "establishment",
			isA: [],
			assertions: [
				{
					id: "assert-pharmacy-medication",
					relation: "affords",
					target: "obtain_medication",
					modality: "necessary",
					provenance,
				},
			],
			provenance,
			status: "active",
		},
	],
	mappings: [
		{
			id: "map-poi-pharmacy",
			concept: "pharmacy",
			vocabulary: "poi-taxonomy",
			externalID: "pharmacy",
			provenance,
		},
	],
}

function file(path: string, value: unknown): GeographicModelSourceFile {
	return { path, text: prettyJSON(value) }
}

const relationFile = file("relations/affords.json", relations)

function slice(): GeographicModelSourceFile[] {
	return [
		file(MODEL_MANIFEST_FILENAME, manifest),
		file("concepts/activities.json", activities),
		file("concepts/establishments.json", establishments),
		relationFile,
	]
}

function issuesOf(run: () => unknown): GeographicModelLoadError {
	try {
		run()
	} catch (error) {
		if (error instanceof GeographicModelLoadError) return error

		throw error
	}

	throw new Error("the load was expected to fail and did not")
}

async function writeModelDirectory(files: readonly GeographicModelSourceFile[]): Promise<string> {
	const root = fixtures.use(await temporaryDirectory("geographic-model-")).path

	for (const entry of files) {
		const path = resolve(root, entry.path)

		await makeDirectories(resolve(path, ".."))
		await writeLocalFile(entry.text, path)
	}

	return root
}

describe("the authoring layout carries no meaning", () => {
	it("produces one table and one artifact whatever order the files arrive in", () => {
		const forward = mergeGeographicModelFiles(slice())
		const backward = mergeGeographicModelFiles(slice().toReversed())

		expect(backward).toEqual(forward)

		expect(serializeCompiledModel(compileGeographicModel(backward))).toBe(
			serializeCompiledModel(compileGeographicModel(forward))
		)
	})

	it("reads a directory the same way twice", async () => {
		const root = writeModelDirectory(slice())
		const once = serializeCompiledModel(compileGeographicModel(await loadGeographicModelDirectory(await root)))

		expect(serializeCompiledModel(compileGeographicModel(await loadGeographicModelDirectory(await root)))).toBe(once)
		expect(once).toContain(`"modelVersion": "0.1.0"`)
	})

	it("merges a table split across files, and one file holding several tables", async () => {
		const document = await loadGeographicModelDirectory(await writeModelDirectory(slice()))

		expect(document.concepts.map((concept) => concept.id)).toEqual(["obtain_medication", "pharmacy"])
		expect(document.mappings).toHaveLength(1)
		expect(document.derivedFacts).toEqual([])
	})
})

describe("a failure names the file", () => {
	it("names the source path of a file that is not JSON", () => {
		const files = [...slice(), { path: "concepts/broken.json", text: "{ not json" }]
		const [issue] = issuesOf(() => mergeGeographicModelFiles(files)).issues

		expect(issue?.file).toBe("concepts/broken.json")
		expect(issue?.code).toBe(LoadIssueCode.MalformedJSON)
	})

	it("names both files when two of them claim one identifier", () => {
		// `concepts/duplicate.json` sorts first, so it is the claimant every second claim is reported against.
		const files = [...slice(), file("concepts/duplicate.json", establishments)]

		const duplicates = issuesOf(() => mergeGeographicModelFiles(files)).issues.filter(
			(issue) => issue.code === ValidationIssueCode.DuplicateID
		)

		// The concept, the assertion nested inside it, and the mapping the same file carries — each at its own address,
		// each naming the file that claimed the identifier and the file that claimed it first.
		expect(duplicates.map((issue) => [issue.path, issue.file, issue.otherFile])).toEqual([
			["$.concepts[2].id", "concepts/establishments.json", "concepts/duplicate.json"],
			["$.concepts[2].assertions[0].id", "concepts/establishments.json", "concepts/duplicate.json"],
			["$.mappings[1].id", "concepts/establishments.json", "concepts/duplicate.json"],
		])
	})

	it("names the file a record was authored in, not its position in the merged table", () => {
		const broken = {
			concepts: [{ ...establishments.concepts[0], kind: "settlement" }],
		}

		const files = [
			file(MODEL_MANIFEST_FILENAME, manifest),
			file("concepts/activities.json", activities),
			relationFile,
			file("concepts/zz-broken.json", broken),
		]

		const [issue] = issuesOf(() => mergeGeographicModelFiles(files)).issues

		// Second concept in the merged table, second file on disk — an author can only act on the second address.
		expect(issue?.path).toBe("$.concepts[1].kind")
		expect(issue?.file).toBe("concepts/zz-broken.json")
		expect(issue?.code).toBe(ValidationIssueCode.UnknownConceptKind)
	})

	it("refuses a directory with no manifest", () => {
		const { issues } = issuesOf(() => mergeGeographicModelFiles(slice().slice(1)))

		expect(issues.map((issue) => [issue.file, issue.code])).toEqual([
			[MODEL_MANIFEST_FILENAME, LoadIssueCode.MissingField],
		])
	})

	it("refuses a version authored outside the manifest, and says where it belongs", () => {
		const { issues } = issuesOf(() => mergeGeographicModelFiles([...slice(), file("c/v.json", { version: "9.9.9" })]))

		expect(issues.map((issue) => issue.file)).toEqual(["c/v.json"])
		expect(issues[0]?.message).toContain(MODEL_MANIFEST_FILENAME)
	})

	it("refuses a key that is not a table rather than dropping the records under it", () => {
		const { issues } = issuesOf(() =>
			mergeGeographicModelFiles([...slice(), file("c/typo.json", { conceptz: activities.concepts })])
		)

		expect(issues.map((issue) => [issue.file, issue.code, issue.path])).toEqual([
			["c/typo.json", ValidationIssueCode.UnknownField, "$.conceptz"],
		])
	})
})
