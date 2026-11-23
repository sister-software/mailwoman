// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * @file Rewrites every tracked first-party source file to start with the SPDX header.
 *
 * `--check` lists what a write would change and exits 1 when anything would.
 * Without it, the tool writes each changed file.
 * The counts separate files that had the old JSDoc header from files that had none.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { trackedFiles } from "@mailwoman/core/git"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { isScriptSourcePath, rewriteSourceHeader, sourceHeaderSyntax } from "@mailwoman/core/spdx-header"
import { parseSync } from "oxc-parser"

const OLD_HEADER = /^[\t ]*(?:\*|\/\/|#)[\t ]*@copyright Sister Software\b/m

async function main(): Promise<number> {
	const { values } = parseArguments({
		options: {
			check: { type: "boolean" },
			list: { type: "boolean" },
		},
	})

	const counts = { replaced: new Map<string, number>(), added: new Map<string, number>(), unchanged: 0 }
	const changed: string[] = []

	for (const path of await trackedFiles()) {
		const syntax = sourceHeaderSyntax(path)

		if (syntax == null) continue

		const absolute = repoRootPath(path)
		const before = await readLocalTextFile(absolute)

		// A script's old header is recognized only inside a comment the parser reports, never in a template literal.
		const comments = isScriptSourcePath(path)
			? parseSync(path, before).comments.map((comment) => [comment.start, comment.end] as const)
			: undefined

		const after = rewriteSourceHeader(before, syntax, comments)

		if (after === before) {
			counts.unchanged++

			continue
		}

		const extension = /\.([a-z]+)$/.exec(path)?.[1] ?? ""
		const bucket = OLD_HEADER.test(before) ? counts.replaced : counts.added

		bucket.set(extension, (bucket.get(extension) ?? 0) + 1)
		changed.push(path)

		if (!values.check) {
			await writeLocalTextFile(after, absolute)
		}
	}

	const total = (bucket: Map<string, number>) => [...bucket.values()].reduce((sum, count) => sum + count, 0)

	console.log(
		stringifyJSON({
			mode: values.check ? "check" : "write",
			replacedOldHeader: { total: total(counts.replaced), byExtension: Object.fromEntries(counts.replaced) },
			addedWhereMissing: { total: total(counts.added), byExtension: Object.fromEntries(counts.added) },
			unchanged: counts.unchanged,
		})
	)

	if (values.list) {
		for (const path of changed) {
			console.log(path)
		}
	}

	return values.check && changed.length ? 1 : 0
}

process.exitCode = await main()
