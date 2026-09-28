/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The regression pin: bumping `release.config.json#version` changes exactly the version line — the
 *   `weights` block, the model identity a code-only release must never move, stays byte-equivalent. The bump
 *   is a targeted textual replacement because the file is oxfmt-formatted and a parse-then-stringify write
 *   would reformat it wholesale.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { bumpReleaseConfigVersion } from "@mailwoman/release-kit/release/config-version"
import { resolvePath } from "path-ts"
import { beforeAll, describe, expect, it } from "vitest"

describe("release.config.json under the prepare bump", () => {
	const path = resolvePath(repoRootPath(), "release.config.json")
	let original: string
	let currentVersion: string

	beforeAll(async () => {
		original = await readLocalTextFile(path)
		currentVersion = parseJSONStrict<{ version: string }>(original).version
	})

	it("a bump changes exactly one line and leaves the weights block byte-equivalent", () => {
		const bumped = bumpReleaseConfigVersion(original, currentVersion, "999.0.0")
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One committed config file, compared line-by-line once.
		const originalLines = original.split("\n")
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Same bounded file, the bumped twin.
		const bumpedLines = bumped.split("\n")
		const changedLines = bumpedLines.filter((line, index) => line !== originalLines[index])

		expect(changedLines).toEqual(['\t"version": "999.0.0",'])

		const weightsOf = (text: string): string => stringifyJSON(parseJSONStrict<{ weights: unknown }>(text).weights)

		expect(weightsOf(bumped)).toBe(weightsOf(original))
	})

	it("refuses a version the file does not carry — the sync check restated at the write", () => {
		expect(() => bumpReleaseConfigVersion(original, "0.0.1", "999.0.0")).toThrow(/version drift/)
	})

	it("carries the current release number, not a lagged one", async () => {
		const rootManifestPath = resolvePath(repoRootPath(), "package.json")
		const root = await readPackageJSON(rootManifestPath)

		expect(currentVersion).toBe(root.version)
	})
})
