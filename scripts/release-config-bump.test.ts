/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The #1891 regression pin: bumping `release.config.json#version` changes EXACTLY the version line — the
 *   `weights` block (the model identity, which a code-only release must never move) stays byte-equivalent. v9.2.0
 *   shipped while this file read 9.1.0 because nothing bumped it (#1024's drift class); the bump is a targeted
 *   textual replacement because the file is oxfmt-formatted and a parse-then-stringify write would reformat it
 *   wholesale (measured: the single-line `locales` array expands to eleven lines).
 */

import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { parseJSONStrict } from "@mailwoman/core/objects"
import { repoRootPath } from "@mailwoman/core/utils"
import { readFileSync } from "@mailwoman/platform/fs"
import { resolve } from "@mailwoman/platform/path"
import { describe, expect, it } from "vitest"

import { bumpReleaseConfigVersion } from "./release-config-version.ts"

describe("release.config.json under the prepare bump", () => {
	const path = resolve(String(repoRootPath()), "release.config.json")
	const original = readFileSync(path, "utf8")
	const currentVersion = parseJSONStrict<{ version: string }>(original).version

	it("a bump changes exactly one line and leaves the weights block byte-equivalent", () => {
		const bumped = bumpReleaseConfigVersion(original, currentVersion, "999.0.0")
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- One committed config file, compared line-by-line once.
		const originalLines = original.split("\n")
		// oxlint-disable-next-line mailwoman/prefer-spliterator -- Same bounded file, the bumped twin.
		const bumpedLines = bumped.split("\n")
		const changedLines = bumpedLines.filter((line, index) => line !== originalLines[index])

		expect(changedLines).toEqual(['\t"version": "999.0.0",'])

		const weightsOf = (text: string): string => JSON.stringify(parseJSONStrict<{ weights: unknown }>(text).weights)

		expect(weightsOf(bumped)).toBe(weightsOf(original))
	})

	it("refuses a version the file does not carry — the sync check restated at the write", () => {
		expect(() => bumpReleaseConfigVersion(original, "0.0.1", "999.0.0")).toThrow(/version drift/)
	})

	it("carries the current release number, not a lagged one", async () => {
		const rootManifestPath = resolve(String(repoRootPath()), "package.json")
		const root = await readLocalJSONFile<{ version: string }>(rootManifestPath)

		// The v9.2.0 incident: the root moved and this file did not. The prepare bump now writes both,
		// and its pre-write sync check refuses drift — this assertion is the standing regression check.
		expect(currentVersion).toBe(root.version)
	})
})
