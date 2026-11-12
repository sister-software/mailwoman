// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Tests the header rewrite on each old header form found in the tree, and that a correct file stays unchanged.
 */

import { describe, expect, test } from "vitest"

import { rewriteSourceHeader, SourceHeaderSyntax, sourceHeaderProblem, sourceHeaderSyntax } from "#spdx-header"

const SLASH =
	"// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors\n// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial\n"

describe("rewriteSourceHeader", () => {
	test("keeps the other tags of a header block", () => {
		const before =
			'/**\n * @copyright Sister Software\n * @license AGPL-3.0\n * @author Teffen Ellis, et al.\n * @file The module.\n */\n\nimport { a } from "a"\n'

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(
			`${SLASH}\n/**\n * @file The module.\n */\n\nimport { a } from "a"\n`
		)
	})

	test("drops the empty star line between the tags and the prose", () => {
		const before =
			"/**\n * @copyright Sister Software.\n * @license AGPL-3.0\n * @author Teffen Ellis, et al.\n *\n *   Prose.\n */\n\nexport const a = 1\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(
			`${SLASH}\n/**\n *   Prose.\n */\n\nexport const a = 1\n`
		)
	})

	test("deletes a header block left empty", () => {
		const before =
			"/**\n * @copyright Sister Software\n * @license AGPL-3.0\n * @author Teffen Ellis, et al.\n */\n\nexport const a = 1\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(`${SLASH}\nexport const a = 1\n`)
	})

	test("moves the header above imports that were added over it", () => {
		const before =
			'import { a } from "a"\n/**\n * @copyright Sister Software · @license AGPL-3.0 · @author Teffen Ellis, et al.\n *\n *   Prose.\n */\nexport const b = a\n'

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(
			`${SLASH}\nimport { a } from "a"\n/**\n *   Prose.\n */\nexport const b = a\n`
		)
	})

	test("writes the header after a shebang", () => {
		const before =
			"#!/usr/bin/env node\n/**\n * @copyright Sister Software\n * @license AGPL-3.0\n * @author Teffen Ellis, et al.\n */\n\nmain()\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(`#!/usr/bin/env node\n${SLASH}\nmain()\n`)
	})

	test("rewrites a Rust header and keeps the inner doc comment", () => {
		const before =
			"// @copyright Sister Software\n// @license AGPL-3.0\n// @author Teffen Ellis, et al.\n\n//! The crate.\n\nfn main() {}\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(`${SLASH}\n//! The crate.\n\nfn main() {}\n`)
	})

	test("rewrites a shell header inside a longer comment run", () => {
		const before =
			"#!/usr/bin/env bash\n#\n# @copyright Sister Software\n# @license AGPL-3.0\n# @author Teffen Ellis, et al.\n#\n# Build the loader.\n\nset -e\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Hash)).toBe(
			"#!/usr/bin/env bash\n# SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors\n# SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial\n\n# Build the loader.\n\nset -e\n"
		)
	})

	test("writes CSS headers as block comments", () => {
		const before =
			"/**\n * @copyright Sister Software\n * @license AGPL-3.0\n * @author Teffen Ellis, et al.\n */\n\n.a {\n}\n"

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.CSS)).toBe(
			"/* SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors */\n/* SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial */\n\n.a {\n}\n"
		)
	})

	test("adds the header to a file that has none", () => {
		expect(rewriteSourceHeader("export const a = 1\n", SourceHeaderSyntax.Slash)).toBe(`${SLASH}\nexport const a = 1\n`)
	})

	test("leaves a generator's template literal that spells the old header", () => {
		const before = `${SLASH}\nconst source =\n\t\`/**\\n\` +\n\t\` * @copyright Sister Software\\n\` +\n\t\` */\\n\`\n`

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash)).toBe(before)
	})

	test("rewrites only real comments when the parser's comment ranges are given", () => {
		const generator = "const source = `/**\n * @copyright Sister Software\n * @license AGPL-3.0\n */\n`\n"
		const before = `/**\n * @copyright Sister Software\n * @license AGPL-3.0\n */\n\n${generator}`
		const headerEnd = before.indexOf("*/") + 2

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash, [[0, headerEnd]])).toBe(`${SLASH}\n${generator}`)
	})

	test("rewrites a second header comment further down the file", () => {
		const before =
			"/**\n * @file A.\n */\n\nexport const a = 1\n\n/**\n * @copyright Sister Software\n * @license AGPL-3.0\n *\n *   B.\n */\n\nexport const b = 2\n"

		const comments: [number, number][] = [
			[0, before.indexOf("*/") + 2],
			[before.lastIndexOf("/**"), before.lastIndexOf("*/") + 2],
		]

		expect(rewriteSourceHeader(before, SourceHeaderSyntax.Slash, comments)).toBe(
			`${SLASH}\n/**\n * @file A.\n */\n\nexport const a = 1\n\n/**\n *   B.\n */\n\nexport const b = 2\n`
		)
	})

	test("is idempotent", () => {
		const once = rewriteSourceHeader(
			"/**\n * @copyright Sister Software\n * @file A.\n */\nexport {}\n",
			SourceHeaderSyntax.Slash
		)

		expect(rewriteSourceHeader(once, SourceHeaderSyntax.Slash)).toBe(once)
	})
})

describe("sourceHeaderProblem", () => {
	test("accepts a correct file", () => {
		expect(sourceHeaderProblem(`${SLASH}\nexport const a = 1\n`, SourceHeaderSyntax.Slash)).toBeNull()
	})

	test("refuses a header that touches the first import, which oxfmt's import sorter would move", () => {
		expect(sourceHeaderProblem(`${SLASH}import { a } from "a"\n`, SourceHeaderSyntax.Slash)).not.toBeNull()
	})
})

describe("sourceHeaderSyntax", () => {
	test("exempts generated and fixture paths", () => {
		expect(sourceHeaderSyntax("packages/sentencepiece-wasm/sentencepiece.mjs")).toBeNull()
		expect(sourceHeaderSyntax("config/vale/fixtures/clean.ts")).toBeNull()
		expect(sourceHeaderSyntax("packages/core/lib/spdx-header.ts")).toBe(SourceHeaderSyntax.Slash)
		expect(sourceHeaderSyntax("docs/plans/a.md")).toBeNull()
	})
})
