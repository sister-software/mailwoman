#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The `mwops` binary: argv in, exit code out. Everything else is `dispatch.ts`, so the routing is testable without a
 *   process.
 */

import { repoRootPath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"

import { dispatch } from "#dispatch"

const repoRoot = String(repoRootPath())

process.exitCode =
	(await runCLICommand(() =>
		dispatch([...cliArguments()], {
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			repoRoot,
			trackedFiles: async () => {
				const result = spawnProcessSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" })

				// oxlint-disable-next-line mailwoman/prefer-spliterator -- `git ls-files` output is bounded by the checkout and every line is needed
				return String(result.stdout ?? "")
					.split("\n")
					.filter((line) => line.length > 0)
			},
		})
	)) ?? 0
