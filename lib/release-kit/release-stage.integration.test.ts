/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Regression fixtures for the release preflight and the release-list identity.
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { trackedFiles } from "@mailwoman/core/git"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { isPresent } from "@mailwoman/core/objects"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { runProcess } from "@mailwoman/core/process"
import type { PathBuilder } from "path-ts"
import { TextSpliterator } from "spliterator"
import { afterAll, describe, expect, it } from "vitest"

import { packWorkspaceForPublish } from "#release-kit/pack/pack-workspace"
import { collectDataFileEntries, literalFilesEntries, verifyTarball } from "#release-kit/pack/verify-tarball"
import {
	assertWorkspacePublishable,
	checkReleaseListIdentity,
	SANCTIONED_RELEASE_ABSENCES,
} from "#release-kit/release/stage"
import { planWeightsMaterialization } from "#release-kit/weights/fetch-hf-weights"

const fixtures = new AsyncDisposableStack()

afterAll(() => fixtures.disposeAsync())

describe("checkReleaseListIdentity", () => {
	it("holds on the current tree: 64 published, every absence sanctioned by name", async () => {
		const identity = await checkReleaseListIdentity(repoRootPath())

		expect(identity.publishCount).toBe(64)
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
	it("refuses a held-out workspace and quotes the reason it is held for", () => {
		expect(() => assertWorkspacePublishable("packages/tile-worker")).toThrow(/held out of the release/)
		expect(() => assertWorkspacePublishable("packages/tile-worker")).toThrow(/private demo-map tile worker/)
	})

	it("refuses the release-it workspace path shape, which carries a leading ./", () => {
		// `@release-it-plugins/workspaces` passes `./<workspace>`
		// through RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE.
		// A literal key check would admit that spelling while refusing the bare one.
		expect(() => assertWorkspacePublishable("./packages/tile-worker")).toThrow(/held out of the release/)
		expect(() => assertWorkspacePublishable("./packages/tile-worker/")).toThrow(/held out of the release/)
	})

	it("admits a workspace the release list names", () => {
		expect(() => assertWorkspacePublishable("./packages/neural-weights-en-us")).not.toThrow()
		expect(() => assertWorkspacePublishable("packages/core")).not.toThrow()
		expect(() => assertWorkspacePublishable("packages/osm")).not.toThrow()
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

		const packed = await runProcess("tar", ["czf", tarball, "-C", dir, "package"], { reject: false })

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

	it("refuses data files in a package that declares mailwoman.codeOnly, listing each one", async () => {
		const tarball = await tarballWith(
			{
				name: "@fixture/code-only",
				version: "0.0.0",
				mailwoman: { codeOnly: true },
			},
			["out/index.js", "fixtures/address-point.osm", "address-points-nz-nz.db", "points.geojson"]
		)

		expect(() => verifyTarball(tarball)).toThrow(/declares mailwoman\.codeOnly and ships data files/)
		expect(() => verifyTarball(tarball)).toThrow(/fixtures\/address-point\.osm/)
		expect(() => verifyTarball(tarball)).toThrow(/address-points-nz-nz\.db/)
		expect(() => verifyTarball(tarball)).toThrow(/points\.geojson/)
	})

	it("admits the same data files in a package that makes no code-only declaration", async () => {
		const tarball = await tarballWith({ name: "@fixture/data-package", version: "0.0.0" }, ["points.geojson"])

		expect(() => verifyTarball(tarball)).not.toThrow()
	})
})

describe("the packed @mailwoman/osm tarball", () => {
	it("declares itself code-only and ships no OpenStreetMap, SQLite or GeoJSON file", async () => {
		const workspace = repoRootPathBuilder("packages", "osm")
		const manifest = await readPackageJSON<{ mailwoman?: { codeOnly?: boolean } }>(workspace("package.json"))

		expect(manifest.mailwoman?.codeOnly).toBe(true)

		const dir = fixtures.use(await temporaryDirectory("mw-osm-pack-")).path
		const tarball = dir("osm.tgz")

		await packWorkspaceForPublish(workspace, tarball)

		const listing = await runProcess("tar", ["-tzf", tarball])
		const entries = TextSpliterator.from(listing.stdout).filter(isPresent).toArray()

		expect(entries.length).toBeGreaterThan(0)
		expect(collectDataFileEntries(entries)).toEqual([])
		expect(() => verifyTarball(tarball)).not.toThrow()
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

	async function trackedPaths(): Promise<Set<string>> {
		return new Set(await trackedFiles(repoRoot, ["--", "packages"]))
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
		const tracked = await trackedPaths()

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
		const tracked = await trackedPaths()

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

		const matches = (await trackedFiles(repoRoot)).filter((path) => path.endsWith(".test.ts") && path.includes(filter))

		expect(matches.length).toBeGreaterThan(0)
	})
})
