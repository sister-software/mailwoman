/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Tests that the loader ignores file layout and attributes each issue to its source file.
 *
 *   The order test reverses the file list passed to the merge, because a test cannot control
 *   `readdir` order on a real filesystem.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalFile, makeDirectories } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { compileGeographicModel, serializeCompiledModel, ValidationIssueCode } from "@mailwoman/geographic-model"
import {
	type GeographicModelSourceFile,
	GeographicModelLoadError,
	loadGeographicModelDirectory,
	LoadIssueCode,
	mergeGeographicModelFiles,
	MODEL_MANIFEST_FILENAME,
} from "@mailwoman/geographic-model/load"
import { dirname, resolvePath } from "path-ts"
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

function sourceFiles(): GeographicModelSourceFile[] {
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
		const path = root(entry.path)

		await makeDirectories(dirname(path))
		await writeLocalFile(entry.text, path)
	}

	return resolvePath(root)
}

describe("the authoring layout carries no meaning", () => {
	it("produces one table and one artifact whatever order the files arrive in", () => {
		const forward = mergeGeographicModelFiles(sourceFiles())
		const backward = mergeGeographicModelFiles(sourceFiles().toReversed())

		expect(backward).toEqual(forward)

		expect(serializeCompiledModel(compileGeographicModel(backward))).toBe(
			serializeCompiledModel(compileGeographicModel(forward))
		)
	})

	it("reads a directory the same way twice", async () => {
		const root = writeModelDirectory(sourceFiles())
		const once = serializeCompiledModel(compileGeographicModel(await loadGeographicModelDirectory(await root)))

		expect(serializeCompiledModel(compileGeographicModel(await loadGeographicModelDirectory(await root)))).toBe(once)
		expect(once).toContain(`"modelVersion": "0.1.0"`)
	})

	it("merges a table split across files, and one file holding several tables", async () => {
		const document = await loadGeographicModelDirectory(await writeModelDirectory(sourceFiles()))

		expect(document.concepts.map((concept) => concept.id)).toEqual(["obtain_medication", "pharmacy"])
		expect(document.mappings).toHaveLength(1)
		expect(document.derivedFacts).toEqual([])
	})
})

describe("a failure names the file", () => {
	it("names the source path of a file that is not JSON", () => {
		const files = [...sourceFiles(), { path: "concepts/broken.json", text: "{ not json" }]
		const [issue] = issuesOf(() => mergeGeographicModelFiles(files)).issues

		expect(issue?.file).toBe("concepts/broken.json")
		expect(issue?.code).toBe(LoadIssueCode.MalformedJSON)
	})

	it("names both files when two of them claim one identifier", () => {
		// `concepts/duplicate.json` sorts first, so every duplicate issue reports it as the first user.
		const files = [...sourceFiles(), file("concepts/duplicate.json", establishments)]

		const duplicates = issuesOf(() => mergeGeographicModelFiles(files)).issues.filter(
			(issue) => issue.code === ValidationIssueCode.DuplicateID
		)

		// The concept, its nested assertion and the mapping each produce one duplicate issue.
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

		// The issue keeps the merged-table path and adds the source file.
		expect(issue?.path).toBe("$.concepts[1].kind")
		expect(issue?.file).toBe("concepts/zz-broken.json")
		expect(issue?.code).toBe(ValidationIssueCode.UnknownConceptKind)
	})

	it("refuses a directory with no manifest", () => {
		const { issues } = issuesOf(() => mergeGeographicModelFiles(sourceFiles().slice(1)))

		expect(issues.map((issue) => [issue.file, issue.code])).toEqual([
			[MODEL_MANIFEST_FILENAME, LoadIssueCode.MissingField],
		])
	})

	it("refuses a version authored outside the manifest, and says where it belongs", () => {
		const { issues } = issuesOf(() =>
			mergeGeographicModelFiles([...sourceFiles(), file("c/v.json", { version: "9.9.9" })])
		)

		expect(issues.map((issue) => issue.file)).toEqual(["c/v.json"])
		expect(issues[0]?.message).toContain(MODEL_MANIFEST_FILENAME)
	})

	it("refuses a key that is not a table rather than dropping the records under it", () => {
		const { issues } = issuesOf(() =>
			mergeGeographicModelFiles([...sourceFiles(), file("c/typo.json", { conceptz: activities.concepts })])
		)

		expect(issues.map((issue) => [issue.file, issue.code, issue.path])).toEqual([
			["c/typo.json", ValidationIssueCode.UnknownField, "$.conceptz"],
		])
	})
})
