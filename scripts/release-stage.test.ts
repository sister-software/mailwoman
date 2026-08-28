/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #1894 preflight's regression fixtures — one per v9.2.0 publish failure, plus the release-list identity.
 *
 *   The four dispatches that cut v9.2.0 died on: a materialization destination that lost its `packages/` prefix, a
 *   parity-test selector left empty by a moved file, an exports target no build produces (the `@mailwoman/corpus`
 *   class), and declared files never materialized (the `@mailwoman/neural-weights-en-au` class). Each is pinned here.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isPresent, parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
import { TextSpliterator } from "spliterator"
import { describe, expect, it } from "vitest"
import { $ } from "zx"

import { planWeightsMaterialization } from "./fetch-hf-weights.ts"
import { checkReleaseListIdentity, SANCTIONED_RELEASE_ABSENCES } from "./release-stage.ts"
import { literalFilesEntries, verifyTarball } from "./verify-tarball.ts"

describe("checkReleaseListIdentity", () => {
	it("holds on the current tree: 53 published, every absence sanctioned by name", () => {
		const identity = checkReleaseListIdentity(String(repoRootPath()))

		expect(identity.publishCount).toBe(53)
		expect(identity.unexpectedAbsences).toEqual([])
		expect(identity.staleSanctions).toEqual([])
		expect(identity.danglingReleaseEntries).toEqual([])
		expect(Object.keys(SANCTIONED_RELEASE_ABSENCES)).toHaveLength(8)
	})

	it("names an unsanctioned absence instead of reporting a count mismatch", () => {
		const root = mkdtempSync(join(tmpdir(), "mw-release-identity-"))

		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ workspaces: ["packages/a", "packages/b", "packages/frozen-one"] })
		)

		writeFileSync(
			join(root, ".release-it.json"),
			JSON.stringify({
				plugins: { "@release-it-plugins/workspaces": { workspaces: ["packages/a", "packages/b"] } },
			})
		)

		const identity = checkReleaseListIdentity(root)

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
	function tarballWith(manifest: object, payloadFiles: string[]): string {
		const dir = mkdtempSync(join(tmpdir(), "mw-tarball-fixture-"))
		const pkgDir = join(dir, "package")

		mkdirSync(pkgDir, { recursive: true })
		writeFileSync(join(pkgDir, "package.json"), JSON.stringify(manifest))

		for (const file of payloadFiles) {
			mkdirSync(join(pkgDir, ...file.split("/").slice(0, -1)), { recursive: true })
			writeFileSync(join(pkgDir, file), "payload")
		}

		const tarball = join(dir, "fixture.tgz")

		const packed = $.sync({ nothrow: true })`tar czf ${tarball} -C ${dir} package`

		if (packed.exitCode !== 0) {
			throw new Error(`tar czf failed: ${packed.stderr}`)
		}

		return tarball
	}

	it("refuses an exports target no build produces — the corpus class", () => {
		const tarball = tarballWith(
			{
				name: "@fixture/corpus-class",
				version: "0.0.0",
				exports: { "./helper": { default: "./out/helper.js" } },
			},
			[]
		)

		expect(() => verifyTarball(tarball)).toThrow(/exports target .*out\/helper\.js is not in the tarball/)
	})

	it("refuses a declared file never materialized — the en-au lexicon class", () => {
		const tarball = tarballWith(
			{
				name: "@fixture/en-au-class",
				version: "0.0.0",
				files: ["model-card.json", "anchor-lexicon-v1.json"],
			},
			["model-card.json"]
		)

		expect(() => verifyTarball(tarball)).toThrow(/files\["anchor-lexicon-v1\.json"\] is not in the tarball/)
	})

	it("passes a tarball that honors its manifest, reporting the audited counts", () => {
		const tarball = tarballWith(
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
	function weightsWorkspaces(): string[] {
		const config = parseJSONStrict<{ locales: string[] }>(readFileSync(join(repoRoot, "release.config.json"), "utf8"))

		return config.locales.map((locale) => `packages/neural-weights-${locale}`)
	}

	function trackedPaths(): Set<string> {
		const listing = $.sync({ cwd: repoRoot })`git ls-files -- packages`

		return new Set([...TextSpliterator.from(listing.stdout)].filter(isPresent))
	}

	it("puts every destination under packages/ — the lost-prefix class", () => {
		// The v9.2.0 cut's FIRST dispatch died on `cp … "$ws/street-type-lexicon-v3.json"` after every workspace
		// moved under `packages/`. Destinations are now derived from one prefix in one function, and this pins it.
		const plans = planWeightsMaterialization(repoRoot)

		expect(plans.length).toBeGreaterThan(0)
		expect(plans.filter((plan) => !plan.workspace.startsWith("packages/neural-weights-"))).toEqual([])
	})

	it("accounts for every declared artifact a checkout cannot supply — the en-au class", () => {
		// What this proves: no literal `files` entry of a release weights package is BOTH untracked and unplanned.
		// That is precisely the state `verify-tarball.ts` refuses at publish time, and precisely what
		// @mailwoman/neural-weights-en-au was in when the audit stopped v9.2.0 after 49 of 51 packages had
		// published. The manifests and the git listing are read here independently of the recipe, so a planner
		// rewritten around a hand-kept list fails this the first time a manifest gains an entry.
		const tracked = trackedPaths()
		const planned = new Set(planWeightsMaterialization(repoRoot).map((plan) => `${plan.workspace}/${plan.filename}`))
		const unaccounted: string[] = []

		for (const workspace of weightsWorkspaces()) {
			const manifest = parseJSONStrict<{ files?: unknown }>(
				readFileSync(join(repoRoot, workspace, "package.json"), "utf8")
			)

			for (const entry of literalFilesEntries(manifest.files)) {
				const path = `${workspace}/${entry}`

				if (!tracked.has(path) && !planned.has(path)) {
					unaccounted.push(path)
				}
			}
		}

		expect(unaccounted).toEqual([])
	})

	it("never plans over a file git already tracks", () => {
		// The other direction: a recipe that materialized `model-card.json` or `calibration.json` would overwrite
		// committed content in the checkout on the publish path, where the destination root IS the checkout.
		const tracked = trackedPaths()

		const clobbered = planWeightsMaterialization(repoRoot)
			.map((plan) => `${plan.workspace}/${plan.filename}`)
			.filter((path) => tracked.has(path))

		expect(clobbered).toEqual([])
	})
})

describe("the pair-index parity selector", () => {
	it("still matches a test file — the empty-selection class", () => {
		// The v9.2.0 cut's SECOND dispatch died because publish.yml named the parity test's pre-regroup path and
		// Vitest matched zero files. The workflow now calls a package script whose filter is the test's NAME, and
		// this asserts the filter is not empty-handed — the same answer a dispatch would return several minutes in.
		const repoRoot = String(repoRootPath())

		const manifest = parseJSONStrict<{ scripts: Record<string, string> }>(
			readFileSync(join(repoRoot, "package.json"), "utf8")
		)

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
