/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Freshness guard for the committed man page. `man/mailwoman.1` is generated from the CLI's own help tree by
 *   `mailwoman dev generate man-page`, and a help-text edit that forgets to regenerate would ship a manual that
 *   contradicts `--help`. Re-renders here (in memory, no tree write) and compares byte-for-byte; the fix on failure is
 *   one command, named in the assertion. Also pins the npm wiring — a page that ships without `package.json#man` never
 *   reaches `man mailwoman`.
 */

import { readLocalJSONFile, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { MAN_PAGE_PATH, renderManPage } from "mailwoman/dev-tools/man-page"
import { describe, expect, it } from "vitest"

describe("the man page", () => {
	// Eight sequential CLI spawns (version + root + six commands), including their selected command imports.
	it(
		"matches the CLI's live help tree — regenerate with `mailwoman dev generate man-page` on drift",
		{ timeout: 60_000 },
		async () => {
			const committed = await readLocalTextFile(MAN_PAGE_PATH)

			expect(committed).toBe(await renderManPage())
		}
	)

	it("is wired into package.json (npm links `man` on install) and shipped in `files`", async () => {
		const pkg = await readLocalJSONFile<{ man?: string; files: string[] }>(
			resolvePackagePath("mailwoman", "package.json")
		)

		expect(pkg.man).toBe("./man/mailwoman.1")
		expect(pkg.files).toContain("man/mailwoman.1")
	})
})
