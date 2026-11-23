// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * Lists prose candidates containing comma-and joins for review.
 *
 * This tool reads source files and never rewrites them.
 * A candidate isn't a defect.
 *
 * The output provides the file, line, and sentence context needed for review.
 *
 * Usage: `node packages/mailwoman/tools/dev-tools/repository/prose-candidates.run.ts [--workspace <name-or-path>]`
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { workingTreeFiles } from "@mailwoman/core/repo/git"
import { readWorkspaceDirectories } from "@mailwoman/core/repo/workspaces"
import { runIfScript } from "@mailwoman/core/scripting"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { resolvePath } from "path-ts"
import { TextSpliterator } from "spliterator"

const PROSE_EXTENSIONS = new Set([".ts", ".mts", ".tsx", ".yaml", ".yml", ".md", ".mdx"])
const INSTRUCTION_FILE_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "SKILL.md"])

async function readValeIgnore(): Promise<string[]> {
	const files = ["config/vale/code.valeignore", "config/vale/docs.valeignore"]
	const entries: string[] = []

	for (const file of files) {
		const text = await readLocalTextFile(repoRootPath(file))

		entries.push(
			...TextSpliterator.from(text, { trim: false, skipEmpty: false })
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("#"))
		)
	}

	return entries
}

function ignored(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => {
		const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&")
		const regex = new RegExp(`^${escaped.replaceAll("**", "§").replaceAll("*", "[^/]*").replaceAll("§", ".*")}$`, "u")

		return regex.test(path)
	})
}

function nearbyLines(text: string, offset: number): string {
	const lineStart = text.lastIndexOf("\n", offset - 1) + 1
	const previousStart = text.lastIndexOf("\n", lineStart - 2) + 1
	const lineEnd = text.indexOf("\n", offset)
	const nextEnd = lineEnd === -1 ? -1 : text.indexOf("\n", lineEnd + 1)
	const contextEnd = nextEnd === -1 ? text.length : nextEnd

	return text.slice(previousStart, contextEnd).replaceAll(/\s+/gu, " ").trim()
}

async function main(): Promise<void> {
	const { values } = parseArguments({ options: { workspace: { type: "string" } } })
	const workspaceFilter = values.workspace
	const workspaceDirectories = await readWorkspaceDirectories(repoRootPath())
	const valeIgnore = await readValeIgnore()
	let allowedRoot: string | undefined

	if (workspaceFilter != null) {
		for (const directory of workspaceDirectories) {
			const manifest = await readPackageJSON(resolvePath(repoRootPath(), directory, "package.json"))

			if (
				directory === workspaceFilter ||
				directory.endsWith(`/${workspaceFilter}`) ||
				manifest.name === workspaceFilter
			) {
				allowedRoot = directory

				break
			}
		}

		if (allowedRoot == null) throw new Error(`unknown workspace: ${workspaceFilter}`)
	}

	const scanRoots = allowedRoot ? [allowedRoot] : workspaceDirectories

	for (const path of await workingTreeFiles()) {
		const extension = path.slice(path.lastIndexOf("."))
		const fileName = path.slice(path.lastIndexOf("/") + 1)
		const inWorkspace = scanRoots.some((root) => path.startsWith(`${root}/`))
		const inDocsSurface = path === "docs/README.md" || path.startsWith("docs/src/")

		if (
			!PROSE_EXTENSIONS.has(extension) ||
			INSTRUCTION_FILE_NAMES.has(fileName) ||
			ignored(path, valeIgnore) ||
			!inWorkspace ||
			(scanRoots.includes("docs") && !inDocsSurface && path.startsWith("docs/"))
		)
			continue

		const text = await readLocalTextFile(repoRootPath(path))
		let line = 1
		let lineStart = 0

		for (const match of text.matchAll(/,\s+and\b/gu)) {
			const offset = match.index ?? 0
			let newline = text.indexOf("\n", lineStart)

			while (newline >= 0 && newline < offset) {
				line += 1
				lineStart = newline + 1
				newline = text.indexOf("\n", lineStart)
			}

			console.log(`${path}:${line}: candidate: ${nearbyLines(text, offset)}`)
		}
	}
}

runIfScript(import.meta, main)
