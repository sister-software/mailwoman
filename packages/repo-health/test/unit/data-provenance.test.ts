/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The `data/` provenance guard over a planted tree: an artifact the record names, one it does not, and the files
 *   that document a directory rather than live in it.
 *
 *   The case the check was written for is `reports an artifact the record does not name`. Its live instance was
 *   `packages/poi-taxonomy/data/brands.json`, committed with a builder in another package and no line in its own
 *   directory's `PROVENANCE.md` saying so — found on the check's first run.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { dataProvenanceCheck } from "@mailwoman/repo-health/checks/data-provenance"
import { join, resolvePath } from "path-ts"
import { afterAll, describe, expect, it } from "vitest"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

/**
 * Write a tree of `path → contents` and return the check's context over it.
 *
 * `trackedFiles` is every planted path, because the check reads git's list rather than the
 * filesystem — an untracked artifact is a local build output and not a committed claim.
 */
async function plant(files: Record<string, string>) {
	const repoRoot = String(fixtures.use(await temporaryDirectory("data-provenance-")).path)

	for (const [file, text] of Object.entries(files)) {
		await makeDirectories(join(repoRoot, file.slice(0, file.lastIndexOf("/"))))
		await writeLocalTextFile(text, resolvePath(repoRoot, file))
	}

	return { repoRoot, trackedFiles: Object.keys(files) }
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
		// The live case: `packages/core/data/coarse-placer/` shipped a trained classifier in every copy of
		// `@mailwoman/core` and no record named it. Every artifact in that directory is a level down,
		// so a rule over files alone reported nothing about any of core's four data directories.
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
		// Requiring every file at any depth would ask core's record to list 1,114 vendored
		// dictionary files. Naming the directory is the claim a reader checks.
		const context = await plant({
			"packages/example/data/PROVENANCE.md": "# provenance\n\n`libpostal/` is fetched by `download`.\n",
			"packages/example/data/libpostal/en/street_types.txt": "ave\n",
			"packages/example/data/libpostal/fr/street_types.txt": "rue\n",
		})

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("leaves an untracked subdirectory out, so a build's scratch output is not reported", async () => {
		// The directory list is derived from git's tracked files rather than from a filesystem walk.
		const repoRoot = String(fixtures.use(await temporaryDirectory("data-provenance-")).path)

		await makeDirectories(join(repoRoot, "packages/example/data/scratch"))
		await writeLocalTextFile("{}\n", resolvePath(repoRoot, "packages/example/data/scratch/out.json"))

		await writeLocalTextFile(
			"# provenance\n\nNothing here yet.\n",
			resolvePath(repoRoot, "packages/example/data/PROVENANCE.md")
		)

		const context = { repoRoot, trackedFiles: ["packages/example/data/PROVENANCE.md"] }

		expect(await dataProvenanceCheck.run(context)).toEqual([])
	})

	it("leaves a data directory with no record alone", async () => {
		// Scoped on purpose. Asserting that every `data/` directory must carry a
		// `PROVENANCE.md` is a different claim, and making this check assert it would
		// fail the build on unrelated packages the moment it lands.
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
