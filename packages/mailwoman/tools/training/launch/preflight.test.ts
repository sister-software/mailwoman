/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { isFile } from "@mailwoman/core/fs/readers/stat"
import { repoRootPath } from "@mailwoman/core/paths"
import { describe, expect, it } from "vitest"

import { AUDIT_SCRIPTS } from "#tools/training/launch/preflight"

describe("the preflight's audit commands", () => {
	// The preflight runs each audit by path, a string the compiler does not resolve,
	// so a module move breaks it only at launch.
	it.each(AUDIT_SCRIPTS)("runs audits/%s, which exists", async (script) => {
		await expect(isFile(repoRootPath("packages", "mailwoman", "tools", "training", "audits", script))).resolves.toBe(
			true
		)
	})
})
