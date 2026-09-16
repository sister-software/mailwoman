#!/usr/bin/env node

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { trackedFiles } from "@mailwoman/core/git"
import { stringifyJSON } from "@mailwoman/core/json"
import { repoRootPath } from "@mailwoman/core/paths"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { dirname, resolvePath } from "path-ts"

import { inventorySourceComments } from "#comment-triage"

const repoRoot = String(repoRootPath())
const databasePath = resolvePath(repoRoot, cliArguments()[0] ?? ".cache/mailwoman/comment-triage.sqlite")

const files = (await trackedFiles(repoRoot)).filter(
	(path) =>
		(path.endsWith(".ts") || path.endsWith(".tsx")) &&
		!path.endsWith(".d.ts") &&
		!/(?:^|\/)(?:out|node_modules)\//.test(path)
)

await makeDirectories(dirname(databasePath))
const result = await inventorySourceComments(databasePath, repoRoot, files)
process.stdout.write(`${stringifyJSON({ databasePath, files: files.length, ...result })}\n`)
