import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { MAN_PAGE_PATH, renderManPage } from "mailwoman/dev-tools/man-page"
import { describe, expect, it } from "vitest"

describe("the man page", () => {
	it(
		"matches the CLI's live help tree — regenerate with `mailwoman dev generate man-page` on drift",
		{ timeout: 60_000 },
		async () => {
			const committed = await readLocalTextFile(MAN_PAGE_PATH)

			expect(committed).toBe(await renderManPage())
		}
	)

	it("is wired into package.json (npm links `man` on install) and shipped in `files`", async () => {
		const pkg = await readPackageJSON(import.meta.url, "mailwoman")

		expect(pkg.man).toBe("./man/mailwoman.1")
		expect(pkg.files).toContain("man/mailwoman.1")
	})
})
