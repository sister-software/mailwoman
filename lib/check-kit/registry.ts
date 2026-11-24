// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The registry of checks `mwops check` runs: each one a root `yarn` script,
 * unchanged, with the parser that reads its output.
 *
 * A heavy check takes the host lock before it starts, because the lab host has the memory
 * for one compile, lint or suite at a time beside the CI runners it also hosts.
 * A test suite also waits for those runners' CI runs to finish.
 * Every other heavy check starts beside them.
 */

import { OperationEffect } from "@mailwoman/core/scripting"

import { HostLoad } from "#check-kit/host"
import type { ParsedCheckOutput } from "#check-kit/parsed"
import { parseScriptOutput } from "#check-kit/parsers/scripts"

/**
 * How a check reads its output.
 *
 * A Vitest check is read from the JSON report the runner asks Vitest to write.
 */
export const CheckReader = {
	Script: "script",
	Vitest: "vitest",
} as const

export type CheckReader = (typeof CheckReader)[keyof typeof CheckReader]

/**
 * One registered check.
 */
export interface CheckCommand {
	name: string
	description: string
	/**
	 * What the check writes, in the operation vocabulary: `local-write` for a check that writes `out/`.
	 */
	effect: OperationEffect
	/**
	 * What the check waits for before it starts: no wait, the host lock, or CI and then the host lock.
	 */
	hostLoad: HostLoad
	/**
	 * Whether the check takes test paths.
	 * The runner appends them to its arguments.
	 */
	takesPaths: boolean
	/**
	 * The `yarn` arguments that run the check, before any paths or reporter flags.
	 */
	args: readonly string[]
	reader: CheckReader
	/**
	 * Read a script check's output.
	 *
	 * A Vitest check's output is read by the runner from its JSON report.
	 */
	parse?: (output: string, exitCode: number | null) => ParsedCheckOutput
}

/**
 * The checks in the order `mwops check` lists them.
 */
export const checkCommands: readonly CheckCommand[] = [
	{
		name: "compile",
		description: "yarn compile: build every TypeScript project with tsc -b",
		effect: OperationEffect.LocalWrite,
		hostLoad: HostLoad.Heavy,
		takesPaths: false,
		args: ["compile"],
		reader: CheckReader.Script,
		parse: (output, exitCode) => parseScriptOutput(output, exitCode, { emptyIsSuccess: true }),
	},
	{
		name: "typecheck",
		description: "yarn typecheck: compile, then type-check the tests, the docs and the tools",
		effect: OperationEffect.LocalWrite,
		hostLoad: HostLoad.Heavy,
		takesPaths: false,
		args: ["typecheck"],
		reader: CheckReader.Script,
		parse: parseScriptOutput,
	},
	{
		name: "health",
		description: "yarn health: the repository-health scripts",
		effect: OperationEffect.LocalWrite,
		hostLoad: HostLoad.Heavy,
		takesPaths: false,
		args: ["health"],
		reader: CheckReader.Script,
		parse: parseScriptOutput,
	},
	{
		name: "health-tree",
		description:
			"yarn vitest --run lib/repo-health: the repository-health tests, which run the current-tree checks `yarn health` leaves out",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Light,
		takesPaths: false,
		args: ["vitest", "--run", "lib/repo-health"],
		reader: CheckReader.Vitest,
	},
	{
		name: "lint",
		description: "yarn lint: oxlint, oxfmt, code blocks, prose, spelling and health",
		effect: OperationEffect.LocalWrite,
		hostLoad: HostLoad.Heavy,
		takesPaths: false,
		args: ["lint"],
		reader: CheckReader.Script,
		parse: parseScriptOutput,
	},
	{
		name: "prose-code",
		description: "yarn lint:prose:code: Vale over source comments",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Light,
		takesPaths: false,
		args: ["lint:prose:code"],
		reader: CheckReader.Script,
		parse: parseScriptOutput,
	},
	{
		name: "prose-vocab",
		description: "yarn lint:prose:vocab: Vale vocabulary rules over the docs",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Light,
		takesPaths: false,
		args: ["lint:prose:vocab"],
		reader: CheckReader.Script,
		parse: parseScriptOutput,
	},
	{
		name: "vitest",
		description: "yarn vitest --run <paths>: the named test files",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Light,
		takesPaths: true,
		args: ["vitest", "--run"],
		reader: CheckReader.Vitest,
	},
	{
		name: "fast-suite",
		description: "yarn test --run: the root Vitest suite",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Exclusive,
		takesPaths: false,
		args: ["test", "--run"],
		reader: CheckReader.Vitest,
	},
	{
		name: "slow-suite",
		description: "yarn ci:test:slow: the integration suite",
		effect: OperationEffect.Read,
		hostLoad: HostLoad.Exclusive,
		takesPaths: false,
		args: ["ci:test:slow"],
		reader: CheckReader.Vitest,
	},
]

/**
 * Look a check up by its name.
 */
// repo-health-ignore export-name-affix -- `findCheck` reads the repository-health check registry.
export function findCheckCommand(name: string): CheckCommand | null {
	return checkCommands.find((check) => check.name === name) ?? null
}

/**
 * The checks `mwops check preflight` runs, in order: the set `AGENTS.md` requires
 * before a direct push to `main`.
 */
export const PREFLIGHT_CHECKS = ["fast-suite", "prose-code", "prose-vocab", "health", "health-tree"] as const
