// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 * The registry of `mwops probe` operations.
 *
 * `probe.get` starts one workspace's server from this checkout on 127.0.0.1 with port 0,
 * waits for its listening line, sends each `--get` path to it, and stops it by its process id.
 *
 * It is a read operation: it writes only its log under the cache root, outside every checkout.
 *
 * It takes no host lock.
 * On 2026-11-21 each target's server, opened on the lab data root, peaked at 419 to 742 MiB of resident
 * memory over its whole process tree, read from `/proc/<pid>/status` `VmHWM` after its requests.
 *
 * The lock serves jobs that hold gigabytes, such as a compile or a suite, and a server
 * below 1 GiB runs beside one as a `vitest` check of a few files does.
 */

import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { type Operation, OperationEffect, type OperationContext, operationDefiner } from "@mailwoman/core/scripting"
import { stringifyJSON } from "@mailwoman/core/values/json"
import { resolvePath } from "path-ts"
import { z } from "zod"

import { MAX_MAX_BYTES } from "#check-kit/http-get"
import { PROBE_HOST, ProbeExit, type ProbeCommand, type ProbeResult, runProbe } from "#check-kit/probe/server"
import { type ProbeTarget, readProbeTargets } from "#check-kit/probe/targets"

/**
 * What a probe operation receives: the checkout `mwops` runs from, and a reader of interrupts.
 */
export interface ProbeContext extends OperationContext {
	repoRoot: string
	/**
	 * Start watching for SIGINT, SIGTERM and SIGHUP, and return a signal that aborts on the first.
	 *
	 * The probe calls it only once it has a server to stop, so other verbs keep the default handlers.
	 */
	watchInterrupts?: () => AbortSignal
}

/**
 * The default bound on the wait for a listening line: 60 seconds.
 *
 * On the lab data root the servers printed their listening line 2.2 to 4.3 seconds after process start,
 * so the bound is about 14 times the slowest warm startup and leaves room for a cold page cache.
 */
const DEFAULT_STARTUP_TIMEOUT_SECONDS = 60

/**
 * The flags a probe refuses after `--`, because the probe binds the server itself.
 */
const BOUND_FLAGS = /^--(?:host|port)(?:=|$)/u

const ENV_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su

/**
 * The probe's input after the flags parse.
 */
const PROBE_INPUT_SCHEMA = z
	.object({
		workspace: z.string().min(1, "give the workspace to probe, such as `mwops probe ogc`"),
		get: z.array(z.string().startsWith("/", "each --get path starts with /")).min(1, "give at least one --get <path>"),
		"json-path": z.string().min(1).optional(),
		"max-bytes": z.coerce.number().int().positive().max(MAX_MAX_BYTES).optional(),
		env: z.array(z.string().regex(ENV_ASSIGNMENT, "each --env is NAME=value")).default([]),
		"env-file": z.string().min(1).optional(),
		"startup-timeout-seconds": z.coerce.number().positive().default(DEFAULT_STARTUP_TIMEOUT_SECONDS),
		"log-dir": z.string().min(1).optional(),
		"server-arg": z
			.array(z.string().refine((flag) => !BOUND_FLAGS.test(flag), "the probe binds --host and --port itself"))
			.default([]),
	})
	.strict()

type ProbeInput = z.output<typeof PROBE_INPUT_SCHEMA>

/**
 * The result of `mwops probe`: the target, the command, and the probe, or why it didn't run.
 */
interface ProbeOperationResult {
	workspace: string
	target: ProbeTarget | null
	command: string[] | null
	probe: ProbeResult | null
	exitCode: number
	summary: string
}

/**
 * The command that starts `target` from the checkout at `repoRoot`, bound to loopback with port 0.
 */
function planProbeCommand(
	repoRoot: string,
	target: ProbeTarget,
	options: { envFile?: string; serverArgs?: readonly string[] } = {}
): ProbeCommand {
	return {
		executable: process.execPath,
		args: [
			...(options.envFile ? [`--env-file=${options.envFile}`] : []),
			resolvePath(repoRoot, target.entry),
			...target.args,
			"--host",
			PROBE_HOST,
			"--port",
			"0",
			...(options.serverArgs ?? []),
		],
		cwd: repoRoot,
	}
}

function notProbed(workspace: string, summary: string, target: ProbeTarget | null = null): ProbeOperationResult {
	return { workspace, target, command: null, probe: null, exitCode: 2, summary }
}

async function runProbeOperation(input: ProbeInput, context: ProbeContext): Promise<ProbeOperationResult> {
	const targets = await readProbeTargets(context.repoRoot)
	const target = targets.find((entry) => entry.workspace === input.workspace) ?? null

	if (!target) {
		return notProbed(
			input.workspace,
			`no probe target ${input.workspace}; the checkout serves ${targets.map((entry) => entry.workspace).join(", ")}`
		)
	}

	if (!(await pathExists(resolvePath(context.repoRoot, target.entry)))) {
		return notProbed(
			input.workspace,
			`${target.entry} is absent; the ${target.workspace} target runs the compiled tree, so run \`yarn compile\` first`,
			target
		)
	}

	const envFile = input["env-file"] ? resolvePath(context.repoRoot, input["env-file"]) : undefined

	if (envFile && !(await pathExists(envFile))) {
		return notProbed(input.workspace, `the --env-file ${envFile} is absent`, target)
	}

	const command = planProbeCommand(context.repoRoot, target, { envFile, serverArgs: input["server-arg"] })
	const commandList = [command.executable, ...command.args]

	if (context.dryRun) {
		return {
			workspace: target.workspace,
			target,
			command: commandList,
			probe: null,
			exitCode: 0,
			summary: `${target.workspace}: would run ${commandList.join(" ")}`,
		}
	}

	const env = Object.fromEntries(
		input.env.map((assignment) => {
			const [, name, value] = ENV_ASSIGNMENT.exec(assignment)!

			return [name!, value!]
		})
	)

	const result = await runProbe({
		workspace: target.workspace,
		command,
		gets: input.get,
		jsonPath: input["json-path"],
		maxBytes: input["max-bytes"],
		env,
		startupTimeoutMs: input["startup-timeout-seconds"] * 1000,
		logDirectory: input["log-dir"] ? resolvePath(context.repoRoot, input["log-dir"]) : undefined,
		interrupt: context.watchInterrupts?.(),
	})

	return {
		workspace: target.workspace,
		target,
		command: commandList,
		probe: result,
		exitCode: result.exitCode,
		summary: result.summary,
	}
}

/**
 * Human lines for a probe: the summary, each request, the memory, the startup output
 * of a server that never listened, and the log path.
 */
function renderProbeResult(output: ProbeOperationResult): string[] {
	const lines = [output.summary]
	const { probe } = output

	if (!probe) return lines

	if (probe.listening) {
		lines.push(`  listening after ${probe.listening.startupMs} ms: ${probe.listening.line}`)
	}

	for (const request of probe.requests) {
		if (request.status == null) {
			lines.push(
				`  GET ${request.path}: no response (${request.error?.causeCode ?? "no cause code"}) ${request.error?.message ?? ""}`
			)

			continue
		}

		lines.push(
			`  GET ${request.path}: ${request.status} ${request.contentType ?? "(no content type)"} in ${request.durationMs} ms, ${request.bytesRead} byte(s)${request.truncated ? ", truncated" : ""}`
		)

		if (request.json) {
			lines.push(
				request.json.present
					? `    ${request.json.path} = ${stringifyJSON(request.json.value)}`
					: `    ${request.json.path}: absent; ${request.json.error}`
			)
		}

		if (request.body != null) {
			// oxlint-disable-next-line mailwoman/prefer-spliterator -- the body is already buffered and capped at --max-bytes
			for (const bodyLine of request.body.split("\n").slice(0, 20)) {
				lines.push(`    ${bodyLine}`)
			}
		}
	}

	if (probe.memory) {
		const peak = probe.memory.totalPeakKiB

		lines.push(
			`  peak resident memory: ${peak == null ? "unread for at least one process" : `${Math.round(peak / 1024)} MiB`} over ${probe.memory.processes.length} process(es)`
		)
	}

	if (!probe.listening) {
		lines.push("  output:")

		for (const line of probe.outputTail) {
			lines.push(`    ${line}`)
		}
	}

	lines.push(`log: ${probe.logPath}`)

	return lines
}

const defineProbeOperation = operationDefiner<OperationEffect, ProbeContext>()

/**
 * `probe.get`: start a workspace's server, read its routes, and stop it.
 */
const probeGetOperation = defineProbeOperation({
	id: "probe.get",
	description:
		"Start one workspace's server from this checkout on 127.0.0.1 with an unused port, wait for its listening line, send each --get path, and stop it by its process id.",
	effect: OperationEffect.Read,
	options: {
		workspace: { type: "string" },
		get: { type: "string", multiple: true },
		"json-path": { type: "string" },
		"max-bytes": { type: "string" },
		env: { type: "string", multiple: true },
		"env-file": { type: "string" },
		"startup-timeout-seconds": { type: "string" },
		"log-dir": { type: "string" },
		"server-arg": { type: "string", multiple: true },
	},
	inputSchema: PROBE_INPUT_SCHEMA,
	outputSchema: z.custom<ProbeOperationResult>(),
	run: runProbeOperation,
	formatOutput: (output) => renderProbeResult(output).join("\n"),
})

/**
 * Every probe operation, in the order `mwops` lists them.
 */
export const probeOperations = [probeGetOperation] as ReadonlyArray<
	Operation<OperationEffect, ProbeContext, unknown, unknown>
>

/**
 * The exit status a probe operation's output produces.
 */
export function probeExitCode(output: unknown): number {
	const exitCode = (output as Partial<ProbeOperationResult>).exitCode

	return typeof exitCode === "number" ? exitCode : ProbeExit.StopFailed
}

/**
 * Rewrite `<workspace> … -- <server flags>` as `get --workspace <workspace> … --server-arg=<flag> …`.
 *
 * The workspace may then be given as the positional argument, and each flag
 * after `--` reaches the server unchanged, including one that starts with `--`.
 */
export function probeOperationArgs(args: readonly string[]): string[] {
	const separator = args.indexOf("--")
	const own = separator === -1 ? [...args] : args.slice(0, separator)
	const serverArgs = separator === -1 ? [] : args.slice(separator + 1)
	const [workspace, ...rest] = own

	if (workspace == null || workspace.startsWith("-"))
		return [...own, ...serverArgs.map((flag) => `--server-arg=${flag}`)]

	return ["get", "--workspace", workspace, ...rest, ...serverArgs.map((flag) => `--server-arg=${flag}`)]
}
