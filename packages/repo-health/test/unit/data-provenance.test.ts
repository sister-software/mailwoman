/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `data/` provenance guard over a planted tree: an artifact the record names, one it does not, and the files
 *   that document a directory rather than live in it.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { dataProvenanceCheck } from "@mailwoman/repo-health/checks/data-provenance"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Write a tree of `path → contents` and return the check's context over it; `trackedFiles`
 * is every planted path because the check reads git's list rather than the filesystem.
 */
async function plant(files: Record<string, string>) {
	const root = fixtures.use(await temporaryDirectory("data-provenance-")).path

	for (const [file, text] of Object.entries(files)) {
		await writeLocalTextFile(text, root(file))
	}

	return { repoRoot: root.toString(), trackedFiles: Object.keys(files) }
}

describe("dataProvenanceCheck", () => {
	it("accepts a directory whose record names every artifact", async () => {
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\n`table.json` is written by `build-table`.\n",
			"packages/example/data/table.json": "{}\n",
		})

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("reports an artifact the record does not name", async () => {
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\n`table.json` is written by `build-table`.\n",
			"packages/example/data/table.json": "{}\n",
			"packages/example/data/brands.json": "{}\n",
		})

		const diagnostics = await dataProvenanceCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/`brands\.json` is committed/u)
		expect(diagnostics[0]?.file).toBe("packages/example/data/PROVENANCE.md")
	})

	it("reads a README and a license as documentation rather than as artifacts", async () => {
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\nNothing here yet.\n",
			"packages/example/data/README.md": "# data\n",
			"packages/example/data/LICENSE": "AGPL-3.0\n",
		})

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("reports a subdirectory the record does not name", async () => {
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\n`table.json` is written by `build-table`.\n",
			"packages/example/data/table.json": "{}\n",
			"packages/example/data/coarse-placer/weights.bin": "\0",
		})

		const diagnostics = await dataProvenanceCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.message).toMatch(/`coarse-placer\/` is committed/u)
		expect(diagnostics[0]?.file).toBe("packages/example/data/PROVENANCE.md")
	})

	it("asks a record to name a subdirectory rather than the files inside it", async () => {
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\n`libpostal/` is fetched by `download`.\n",
			"packages/example/data/libpostal/en/street_types.txt": "ave\n",
			"packages/example/data/libpostal/fr/street_types.txt": "rue\n",
		})

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("leaves an untracked subdirectory out, so a build's scratch output is not reported", async () => {
		// The directory list is derived from git's tracked files rather than from a filesystem walk.
		const root = fixtures.use(await temporaryDirectory("data-provenance-")).path

		await writeLocalTextFile("{}\n", root("packages/example/data/scratch/out.json"))
		await writeLocalTextFile("# provenance\n\nNothing here yet.\n", root("packages/example/data/PROVENANCE.md"))

		const context = { repoRoot: root.toString(), trackedFiles: ["packages/example/data/PROVENANCE.md"] }

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("leaves a data directory with no record alone", async () => {
		// Deliberately does not require a `PROVENANCE.md` in every `data/` directory.
		const context = await plant({ "packages/example/data/table.json": "{}\n" })

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("reads each package's record against its own directory rather than against every artifact", async () => {
		const context = await plant({
			"packages/one/data/PROVENANCE.md": "# provenance\n\n`one.json` is written by `build-one`.\n",
			"packages/one/data/one.json": "{}\n",
			"packages/two/data/PROVENANCE.md": "# provenance\n\n`one.json` is written by `build-one`.\n",
			"packages/two/data/two.json": "{}\n",
		})

		const diagnostics = await dataProvenanceCheck.run(context)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0]?.file).toBe("packages/two/data/PROVENANCE.md")
	})
})
