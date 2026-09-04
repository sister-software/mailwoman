/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #1894 preflight's regression fixtures — one per v9.2.0 publish failure, plus the release-list identity.
 *
 *   The four dispatches that published v9.2.0 died on: a materialization destination that lost its `packages/` prefix, a
 *   parity-test selector left empty by a moved file, an exports target no build produces (the `@mailwoman/corpus`
 *   class), and declared files never materialized (the `@mailwoman/neural-weights-en-au` class). Each is pinned here.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import { join } from "path-ts"
import { TextSpliterator } from "spliterator"
import { afterAll, describe, expect, it } from "vitest"
import { $ } from "zx"

import { literalFilesEntries, verifyTarball } from "#pack/verify-tarball"
import { checkReleaseListIdentity, SANCTIONED_RELEASE_ABSENCES } from "#release/stage"
import { planWeightsMaterialization } from "#weights/fetch-hf-weights"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("checkReleaseListIdentity", () => {
	it("holds on the current tree: 59 published, every absence sanctioned by name", async () => {
		const identity = await checkReleaseListIdentity(String(repoRootPath()))

		expect(identity.publishCount).toBe(59)
		expect(identity.unexpectedAbsences).toEqual([])
		expect(identity.staleSanctions).toEqual([])
		expect(identity.danglingReleaseEntries).toEqual([])
		expect(Object.keys(SANCTIONED_RELEASE_ABSENCES)).toHaveLength(9)
	})

	it("names an unsanctioned absence instead of reporting a count mismatch", async () => {
		await using rootDirectory = await temporaryDirectory("mw-release-identity-")
		const root = rootDirectory.path

		await writeLocalJSONFile(
			{ workspaces: ["packages/a", "packages/b", "packages/frozen-one"] },
			join(root, "package.json")
		)

		await writeLocalJSONFile(
			{
				plugins: { "@release-it-plugins/workspaces": { workspaces: ["packages/a", "packages/b"] } },
			},
			join(root, ".release-it.json")
		)

		const identity = await checkReleaseListIdentity(root)

		// The en-au class: a workspace outside the release list with no stated reason is FROZEN, and the
		// failure must carry its name, not "expected 3, found 2".
		expect(identity.unexpectedAbsences).toEqual(["packages/frozen-one"])
		expect(identity.publishCount).toBe(2)
	})
})

describe("the tarball audit refuses the two v9.2.0 manifest-promise classes", () => {
	/**
	 * A hand-built tarball: `package/package.json` plus whichever payload files the case ships. No yarn project needed —
	 * the audit reads the archive, and these fixtures pin its refusals without packing a real workspace.
	 */
	async function tarballWith(manifest: object, payloadFiles: string[]): Promise<string> {
		const dir = fixtures.use(await temporaryDirectory("mw-tarball-fixture-")).path
		const pkgDir = join(dir, "package")

		await makeDirectories(pkgDir)
		await writeLocalJSONFile(manifest, join(pkgDir, "package.json"))

		for (const file of payloadFiles) {
			await makeDirectories(join(pkgDir, ...file.split("/").slice(0, -1)))
			await writeLocalTextFile("payload", join(pkgDir, file))
		}

		const tarball = join(dir, "fixture.tgz")

		const packed = $.sync({ nothrow: true })`tar czf ${tarball} -C ${dir} package`

		if (packed.exitCode !== 0) {
			throw new Error(`tar czf failed: ${packed.stderr}`)
		}

		return tarball
	}

	it("refuses an exports target no build produces — the corpus class", async () => {
		const tarball = await tarballWith(
			{
				name: "@fixture/corpus-class",
				version: "0.0.0",
				exports: { "./helper": { default: "./out/helper.js" } },
			},
			[]
		)

		expect(() => verifyTarball(tarball)).toThrow(/exports target .*out\/helper\.js is not in the tarball/)
	})

	it("refuses a declared file never materialized — the en-au lexicon class", async () => {
		const tarball = await tarballWith(
			{
				name: "@fixture/en-au-class",
				version: "0.0.0",
				files: ["model-card.json", "anchor-lexicon-v1.json"],
			},
			["model-card.json"]
		)

		expect(() => verifyTarball(tarball)).toThrow(/files\["anchor-lexicon-v1\.json"\] is not in the tarball/)
	})

	it("passes a tarball that honors its manifest, reporting the audited counts", async () => {
		const tarball = await tarballWith(
			{
				name: "@fixture/clean",
				version: "0.0.0",
				files: ["model-card.json"],
				exports: { ".": { default: "./index.js" } },
			},
			["model-card.json", "index.js"]
		)

		const audit = verifyTarball(tarball)

		expect(audit.name).toBe("@fixture/clean")
		expect(audit.literalFiles).toBe(1)
		expect(audit.exportTargets).toBe(1)
	})
})

describe("the Hugging Face materialization plan", () => {
	const repoRoot = String(repoRootPath())

	/**
	 * The release's weights workspaces, read the way the recipe reads them.
	 */
	async function weightsWorkspaces(): Promise<string[]> {
		const config = await readLocalJSONFile<{ locales: string[] }>(join(repoRoot, "release.config.json"))

		return config.locales.map((locale) => `packages/neural-weights-${locale}`)
	}

	function trackedPaths(): Set<string> {
		const listing = $.sync({ cwd: repoRoot })`git ls-files -- packages`

		return new Set([...TextSpliterator.from(listing.stdout)].filter(isPresent))
	}

	it("puts every destination under packages/ — the lost-prefix class", async () => {
		// The v9.2.0 release's FIRST dispatch died on `cp … "$ws/street-type-lexicon-v3.json"` after every workspace
		// moved under `packages/`. Destinations are now derived from one prefix in one function, and this pins it.
		const plans = await planWeightsMaterialization(repoRoot)

		expect(plans.length).toBeGreaterThan(0)
		expect(plans.filter((plan) => !plan.workspace.startsWith("packages/neural-weights-"))).toEqual([])
	})

	it("accounts for every declared artifact a checkout cannot supply — the en-au class", async () => {
		// What this proves: no literal `files` entry of a release weights package is BOTH untracked and unplanned.
		// That is precisely the state `verify-tarball.ts` refuses at publish time, and precisely what
		// @mailwoman/neural-weights-en-au was in when the audit stopped v9.2.0 after 49 of 51 packages had
		// published. The manifests and the git listing are read here independently of the recipe, so a planner
		// rewritten around a hand-kept list fails this the first time a manifest gains an entry.
		const tracked = trackedPaths()

		const planned = new Set(
			(await planWeightsMaterialization(repoRoot)).map((plan) => `${plan.workspace}/${plan.filename}`)
		)

		const unaccounted: string[] = []

		for (const workspace of await weightsWorkspaces()) {
			const manifest = await readLocalJSONFile<{ files?: unknown }>(join(repoRoot, workspace, "package.json"))

			for (const entry of literalFilesEntries(manifest.files)) {
				const path = `${workspace}/${entry}`

				if (!tracked.has(path) && !planned.has(path)) {
					unaccounted.push(path)
				}
			}
		}

		expect(unaccounted).toEqual([])
	})

	it("never plans over a file git already tracks", async () => {
		// The other direction: a recipe that materialized `model-card.json` or `calibration.json` would overwrite
		// committed content in the checkout on the publish path, where the destination root IS the checkout.
		const tracked = trackedPaths()

		const clobbered = (await planWeightsMaterialization(repoRoot))
			.map((plan) => `${plan.workspace}/${plan.filename}`)
			.filter((path) => tracked.has(path))

		expect(clobbered).toEqual([])
	})
})

describe("the pair-index parity selector", () => {
	it("still matches a test file — the empty-selection class", async () => {
		// The v9.2.0 release's SECOND dispatch died because publish.yml named the parity test's pre-regroup path and
		// Vitest matched zero files. The workflow now calls a package script whose filter is the test's NAME, and
		// this asserts the filter is not empty-handed — the same answer a dispatch would return several minutes in.
		const repoRoot = String(repoRootPath())

		const manifest = await readLocalJSONFile<{ scripts: Record<string, string> }>(join(repoRoot, "package.json"))

		const script = manifest.scripts["ci:test:pair-index-parity"]

		expect(script).toBeDefined()

		const filter = script!.split(/\s+/).at(-1)!
		const listing = $.sync({ cwd: repoRoot })`git ls-files`

		const matches = [...TextSpliterator.from(listing.stdout)]
			.filter(isPresent)
			.filter((path) => path.endsWith(".test.ts") && path.includes(filter))

		expect(matches.length).toBeGreaterThan(0)
	})
})
