/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #1894 preflight's regression fixtures: the release-list identity names every discrepancy instead of
 *   counting, and the tarball audit refuses the two v9.2.0 classes — an exports target no build produces (the
 *   `@mailwoman/corpus` class) and a declared file never materialized (the `@mailwoman/neural-weights-en-au` class).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { repoRootPath } from "@mailwoman/core/utils"
import { describe, expect, it } from "vitest"
import { $ } from "zx"

import { checkReleaseListIdentity, SANCTIONED_RELEASE_ABSENCES } from "./release-stage.ts"
import { verifyTarball } from "./verify-tarball.ts"

describe("checkReleaseListIdentity", () => {
	it("holds on the current tree: 51 published, every absence sanctioned by name", () => {
		const identity = checkReleaseListIdentity(String(repoRootPath()))

		expect(identity.publishCount).toBe(51)
		expect(identity.unexpectedAbsences).toEqual([])
		expect(identity.staleSanctions).toEqual([])
		expect(identity.danglingReleaseEntries).toEqual([])
		expect(Object.keys(SANCTIONED_RELEASE_ABSENCES)).toHaveLength(6)
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
