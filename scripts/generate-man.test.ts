/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Freshness guard for the committed man page (#1577), living BESIDE its generator — the
 *   `derived-weights-key.test.ts` precedent — because a test under `mailwoman/test` cannot import
 *   across that workspace's tsc rootDir (TS6059 in CI's compile leg; vitest alone never sees it).
 *   `mailwoman/man/mailwoman.1` is generated
 *   from the CLI's own help tree by `scripts/generate-man.ts`, and a help-text edit that forgets
 *   to regenerate would ship a manual that contradicts `--help`. Re-renders here (in memory, no
 *   tree write) and compares byte-for-byte; the fix on failure is one command, named in the
 *   assertion. Also pins the npm wiring — a page that ships without `package.json#man` never
 *   reaches `man mailwoman`.
 */

import { readFileSync } from "node:fs"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { describe, expect, it } from "vitest"

import { MAN_PAGE_PATH, renderManPage } from "./generate-man.ts"

describe("the man page", () => {
	// Eight sequential CLI spawns (version + root + six commands), including their selected command imports.
	it(
		"matches the CLI's live help tree — regenerate with `node scripts/generate-man.ts` on drift",
		{ timeout: 60_000 },
		() => {
			const committed = readFileSync(MAN_PAGE_PATH, "utf8")

			expect(committed).toBe(renderManPage())
		}
	)

	it("is wired into package.json (npm links `man` on install) and shipped in `files`", () => {
		const pkg = parseJSONStrict<{ man?: string; files: string[] }>(
			readFileSync(new URL("../mailwoman/package.json", import.meta.url), "utf8")
		)

		expect(pkg.man).toBe("./man/mailwoman.1")
		expect(pkg.files).toContain("man/mailwoman.1")
	})
})
