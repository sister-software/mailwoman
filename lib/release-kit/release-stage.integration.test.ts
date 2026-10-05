/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Regression fixtures for the release preflight and the release-list identity.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { afterAll, describe, expect, it } from "vitest"
import { $ } from "zx"

import { literalFilesEntries, verifyTarball } from "#release-kit/pack/verify-tarball"
import {
	assertWorkspacePublishable,
	checkReleaseListIdentity,
	SANCTIONED_RELEASE_ABSENCES,
} from "#release-kit/release/stage"
import { planWeightsMaterialization } from "#release-kit/weights/fetch-hf-weights"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("checkReleaseListIdentity", () => {
	it("holds on the current tree: 61 published, every absence sanctioned by name", async () => {
		const identity = await checkReleaseListIdentity(repoRootPath())

		expect(identity.publishCount).toBe(61)
		expect(identity.unexpectedAbsences).toEqual([])
		expect(identity.staleSanctions).toEqual([])
		expect(identity.danglingReleaseEntries).toEqual([])
		expect(Object.keys(SANCTIONED_RELEASE_ABSENCES)).toHaveLength(14)
	})

	it("names an unsanctioned absence instead of reporting a count mismatch", async () => {
		await using rootDirectory = await temporaryDirectory("mw-release-identity-")
		const root = rootDirectory.path

		await writeLocalJSONFile({ workspaces: ["packages/a", "packages/b", "packages/frozen-one"] }, root("package.json"))

		// Every workspace in the field must include a manifest.
		// The reader refuses a literal without one.
		for (const workspace of ["packages/a", "packages/b", "packages/frozen-one"]) {
			await makeDirectories(root(workspace))
			await writeLocalJSONFile({ name: workspace }, root(workspace, "package.json"))
		}

		await writeLocalJSONFile(
			{
				plugins: { "@release-it-plugins/workspaces": { workspaces: ["packages/a", "packages/b"] } },
			},
			root(".release-it.json")
		)

		const identity = await checkReleaseListIdentity(root)

		// A workspace outside the release list with no stated reason is frozen.
		// and the failure reports its name.
		expect(identity.unexpectedAbsences).toEqual(["packages/frozen-one"])
		expect(identity.publishCount).toBe(2)
	})
})

describe("assertWorkspacePublishable", () => {
	it("refuses packages/osm and quotes the rights reason it is held for", () => {
		expect(() => assertWorkspacePublishable("packages/osm")).toThrow(/ODbL counsel sign-off pending/)
	})

	it("refuses the release-it workspace path shape, which carries a leading ./", () => {
		// `@release-it-plugins/workspaces` passes `./<workspace>`
		// through RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE.
		// A literal key check would admit that spelling while refusing the bare one.
		expect(() => assertWorkspacePublishable("./packages/osm")).toThrow(/ODbL counsel sign-off pending/)
		expect(() => assertWorkspacePublishable("./packages/osm/")).toThrow(/ODbL counsel sign-off pending/)
	})

	it("refuses a private workspace as well, so one rule covers every entry", () => {
		expect(() => assertWorkspacePublishable("packages/tile-worker")).toThrow(/held out of the release/)
	})

	it("admits a workspace the release list names", () => {
		expect(() => assertWorkspacePublishable("./packages/neural-weights-en-us")).not.toThrow()
		expect(() => assertWorkspacePublishable("packages/core")).not.toThrow()
	})
})

describe("the tarball audit refuses the two v9.2.0 manifest-promise classes", () => {
	/**
	 * A hand-built tarball: `package/package.json` plus whichever payload files the case ships.
	 *
	 * The audit reads the archive, so no yarn project is needed and these fixtures
	 * pin its refusals without packing a real workspace.
	 */
	async function tarballWith(manifest: object, payloadFiles: string[]): Promise<PathBuilder> {
		const dir = fixtures.use(await temporaryDirectory("mw-tarball-fixture-")).path
		const pkgDir = dir("package")

		await makeDirectories(pkgDir)
		await writeLocalJSONFile(manifest, pkgDir("package.json"))

		for (const file of payloadFiles) {
			await makeDirectories(pkgDir(...file.split("/").slice(0, -1)))
			await writeLocalTextFile("payload", pkgDir(file))
		}

		const tarball = dir("fixture.tgz")

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
	const repoRoot = repoRootPath()

	/**
	 * The release's weights workspaces, read the way the recipe reads them.
	 */
	async function weightsWorkspaces(): Promise<string[]> {
		const config = await readLocalJSONFile<{ locales: string[] }>(repoRootPath("release.config.json"))

		return config.locales.map((locale) => `packages/neural-weights-${locale}`)
	}

	function trackedPaths(): Set<string> {
		const listing = $.sync({ cwd: repoRoot })`git ls-files -- packages`

		return TextSpliterator.from(listing.stdout).filter(isPresent).toSet()
	}

	it("puts every destination under packages/ — the lost-prefix class", async () => {
		// Destinations are derived from one prefix in one function.
		const plans = await planWeightsMaterialization(repoRoot)

		expect(plans.length).toBeGreaterThan(0)
		expect(plans.filter((plan) => !plan.workspace.startsWith("packages/neural-weights-"))).toEqual([])
	})

	it("accounts for every declared artifact a checkout cannot supply — the en-au class", async () => {
		// The manifests and the git listing are read here independently of the recipe, so a planner
		// rewritten around a hand-kept list fails this the first time a manifest gains an entry.
		const tracked = trackedPaths()

		const planned = new Set(
			(await planWeightsMaterialization(repoRoot)).map((plan) => `${plan.workspace}/${plan.filename}`)
		)

		const unaccounted: string[] = []

		for (const workspace of await weightsWorkspaces()) {
			const manifest = await readPackageJSON(repoRootPath(workspace, "package.json"))

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
		// The other direction: a recipe that materialized `model-card.json`
		// or `calibration.json` would overwrite committed content in the checkout on the
		// publish path, where the destination root is the checkout.
		const tracked = trackedPaths()

		const clobbered = (await planWeightsMaterialization(repoRoot))
			.map((plan) => `${plan.workspace}/${plan.filename}`)
			.filter((path) => tracked.has(path))

		expect(clobbered).toEqual([])
	})
})

describe("the pair-index parity selector", () => {
	it("still matches a test file — the empty-selection class", async () => {
		// The workflow calls a package script whose filter is the test's name.
		const repoRoot = repoRootPath()

		const manifest = await readPackageJSON(repoRootPath("package.json"))

		const script = manifest.scripts?.["ci:test:pair-index-parity"]

		expect(script).toBeDefined()

		const filter = script!.split(/\s+/).at(-1)!
		const listing = $.sync({ cwd: repoRoot })`git ls-files`

		const matches = TextSpliterator.from(listing.stdout)
			.filter(isPresent)
			.filter((path) => path.endsWith(".test.ts") && path.includes(filter))
			.toArray()

		expect(matches.length).toBeGreaterThan(0)
	})
})
