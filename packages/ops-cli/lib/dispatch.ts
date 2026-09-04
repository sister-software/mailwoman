/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwops`: the private operator CLI. Two verbs, each a view over a registry — `release <operation>` over
 *   `@mailwoman/release-kit` and `health <check>|all` over `@mailwoman/repo-health`. It parses arguments, hands them to
 *   the registered capability, and prints the result; every decision about WHAT happens belongs to the operation or the
 *   check. Kept free of `process` so it is unit-testable: the bin wrapper supplies argv, stdout, and the exit code.
 *
 *   `health baseline debt` is the ONE mutation the health verb performs: it rewrites `packages/repo-health/baseline.json`
 *   from the current readings. Writing a baseline is not a check, so `writeBaseline` is exported by repo-health and not
 *   registered; this is the only caller.
 */

import { findOperation, operations, type ReleaseContext } from "@mailwoman/release-kit"
import {
	checkPassed,
	checks,
	findCheck,
	type Diagnostic,
	type RepoContext,
	writeBaseline,
} from "@mailwoman/repo-health"

export interface DispatchIO {
	stdout: (text: string) => void
	stderr: (text: string) => void
	repoRoot: string
	trackedFiles: () => Promise<readonly string[]>
}

/**
 * `--key value` and `--flag` pairs into an object an operation's `inputSchema` then coerces and validates. Values stay
 * strings here on purpose: the schema is the one place a type is decided.
 */
export function parseOptions(args: readonly string[]): { options: Record<string, string | boolean>; rest: string[] } {
	const options: Record<string, string | boolean> = {}
	const rest: string[] = []

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!

		if (!arg.startsWith("--")) {
			rest.push(arg)

			continue
		}

		const body = arg.slice(2)
		const eq = body.indexOf("=")

		if (eq !== -1) {
			options[body.slice(0, eq)] = body.slice(eq + 1)
		} else if (i + 1 < args.length && !args[i + 1]!.startsWith("--")) {
			options[body] = args[++i]!
		} else {
			options[body] = true
		}
	}

	return { options, rest }
}

function usage(io: DispatchIO): number {
	io.stderr(
		[
			"mwops — the private operator CLI (a view over the release-kit and repo-health registries)",
			"",
			"  mwops release <operation> [--json] [--dry-run] [--key value …]",
			"  mwops health <check>|all [--json]",
			"  mwops health baseline debt        (the one mutation: rewrite packages/repo-health/baseline.json)",
			"",
			`release operations: ${operations.length ? operations.map((operation) => `${operation.id} (${operation.effect})`).join(", ") : "(none registered yet)"}`,
			`health checks:      ${checks.length ? checks.map((check) => check.id).join(", ") : "(none registered yet)"}`,
			"",
		].join("\n")
	)

	return 2
}

async function runRelease(args: readonly string[], io: DispatchIO): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	const operation = findOperation(id.includes(".") ? id : `release.${id}`)

	if (!operation) {
		io.stderr(
			`mwops release: no operation ${JSON.stringify(id)}; registered: ${operations.map((o) => o.id).join(", ") || "(none)"}\n`
		)

		return 2
	}

	const json = options.json === true

	const context: ReleaseContext = {
		repoRoot: io.repoRoot,
		dryRun: options["dry-run"] === true,
		log: json ? () => {} : (line) => io.stderr(`${line}\n`),
	}

	const { json: _json, "dry-run": _dryRun, ...input } = options
	const parsed = operation.inputSchema.safeParse(input)

	if (!parsed.success) {
		io.stderr(`mwops release ${operation.id}: invalid input — ${parsed.error.message}\n`)

		return 2
	}

	const output = await operation.run(parsed.data, context)

	io.stdout(
		json ? `${JSON.stringify(output, null, 2)}\n` : `${String(output === undefined ? "ok" : JSON.stringify(output))}\n`
	)

	return 0
}

/**
 * `mwops health baseline <counter-set>` — rewrite a baseline from the current readings. `debt` is the only counter set
 * with a baseline; the target is named so a second one has a place to go.
 */
async function runBaseline(
	targets: readonly string[],
	options: Record<string, string | boolean>,
	io: DispatchIO
): Promise<number> {
	const target = targets[0]

	if (target !== "debt") {
		io.stderr(`mwops health baseline: no baseline ${JSON.stringify(target ?? "")}; the one that exists is "debt"\n`)

		return 2
	}

	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
	const written = await writeBaseline(context)

	if (options.json === true) {
		io.stdout(`${JSON.stringify(written, null, 2)}\n`)
	} else {
		for (const [name, count] of Object.entries(written.counters)) {
			io.stdout(`${name}: ${count}\n`)
		}

		io.stdout(`Updated ${written.file}\n`)
	}

	return 0
}

async function runHealth(args: readonly string[], io: DispatchIO): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	if (id === "baseline") return await runBaseline(rest.slice(1), options, io)

	const selected = id === "all" ? checks : [findCheck(id)].filter((check) => check !== undefined)

	if (id === "all" && !checks.length) {
		io.stdout(options.json === true ? "[]\n" : "no health checks registered yet\n")

		return 0
	}

	if (!selected.length) {
		io.stderr(
			`mwops health: no check ${JSON.stringify(id)}; registered: ${checks.map((c) => c.id).join(", ") || "(none)"}\n`
		)

		return 2
	}

	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
	const results: Array<{ id: string; passed: boolean; diagnostics: Diagnostic[] }> = []

	for (const check of selected) {
		const diagnostics = await check.run(context)

		results.push({ id: check.id, passed: checkPassed(diagnostics), diagnostics })
	}

	if (options.json === true) {
		io.stdout(`${JSON.stringify(results, null, 2)}\n`)
	} else {
		for (const result of results) {
			io.stdout(`${result.passed ? "✓" : "✗"} ${result.id}\n`)

			for (const diagnostic of result.diagnostics) {
				io.stdout(
					`    ${diagnostic.severity}: ${diagnostic.message}${diagnostic.file ? ` (${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""})` : ""}\n`
				)
			}
		}
	}

	return results.every((result) => result.passed) ? 0 : 1
}

/**
 * Route one invocation. Returns the exit code; never touches `process`.
 */
export async function dispatch(args: readonly string[], io: DispatchIO): Promise<number> {
	const [verb, ...rest] = args

	switch (verb) {
		case "release":
			return await runRelease(rest, io)
		case "health":
			return await runHealth(rest, io)
		default:
			return usage(io)
	}
}
