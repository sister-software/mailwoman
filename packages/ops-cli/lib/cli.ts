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
import { cliArguments } from "@mailwoman/core/scripting/arguments"
import { runCLICommand } from "@mailwoman/core/scripting/command"
import { listTrackedFiles } from "@mailwoman/repo-health"

import { dispatch } from "#dispatch"

const repoRoot = String(repoRootPath())

process.exitCode =
	(await runCLICommand(() =>
		dispatch([...cliArguments()], {
			stdout: (text) => process.stdout.write(text),
			stderr: (text) => process.stderr.write(text),
			repoRoot,
			trackedFiles: () => listTrackedFiles(repoRoot),
		})
	)) ?? 0
