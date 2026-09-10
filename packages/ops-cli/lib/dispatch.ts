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
 *   The health verb performs two mutations, and neither is a check: `health baseline debt` rewrites
 *   `packages/repo-health/baseline.json` from the current readings, and `health fix <check>` applies the mechanical
 *   repair a check's diagnostics describe. Both are exported by repo-health and left out of the check registry, whose
 *   type admits nothing that writes; this is the only caller of either.
 */

import { shopOperations } from "@mailwoman/license-worker/shop"
import { operations, type ReleaseContext, type ReleaseOperation } from "@mailwoman/release-kit"
import {
	applyModuleMoves,
	checkPassed,
	checks,
	findCheck,
	findFix,
	fixes,
	planModuleMoves,
	type Diagnostic,
	type RepoContext,
	writeBaseline,
} from "@mailwoman/repo-health"

/**
 * How many times `health fix` re-takes a plan before giving up. See {@link runFix} for why one pass is not enough.
 */
const MAXIMUM_FIX_PASSES = 8

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
			"mwops — the private operator CLI (a view over the release-kit, shop and repo-health registries)",
			"",
			"  mwops release <operation> [--json] [--dry-run] [--key value …]",
			"  mwops shop <operation> [--json] [--dry-run] [--key value …]",
			"  mwops health <check>|all [--json]",
			"  mwops health baseline debt        (rewrite packages/repo-health/baseline.json from the current readings)",
			"  mwops health fix <check> [--dry-run] [--json]",
			"",
			`release operations: ${operations.length ? operations.map((operation) => `${operation.id} (${operation.effect})`).join(", ") : "(none registered yet)"}`,
			`shop operations:    ${shopOperations.map((operation) => `${operation.id} (${operation.effect})`).join(", ")}`,
			`health checks:      ${checks.length ? checks.map((check) => check.id).join(", ") : "(none registered yet)"}`,
			`health fixes:       ${fixes.length ? fixes.map((fix) => fix.id).join(", ") : "(none registered yet)"}`,
			"",
		].join("\n")
	)

	return 2
}

/**
 * Run one operation of a registry: the release registry under `mwops release`, the shop's under `mwops shop`. The
 * contract is the same object, so the view is one function.
 */
async function runOperation(
	verb: "release" | "shop",
	registry: ReadonlyArray<ReleaseOperation<unknown, unknown>>,
	args: readonly string[],
	io: DispatchIO
): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	const qualified = id.includes(".") ? id : `${verb}.${id}`
	const operation = registry.find((candidate) => candidate.id === qualified)

	if (!operation) {
		io.stderr(
			`mwops ${verb}: no operation ${JSON.stringify(id)}; registered: ${registry.map((o) => o.id).join(", ") || "(none)"}\n`
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
		io.stderr(`mwops ${verb} ${operation.id}: invalid input — ${parsed.error.message}\n`)

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

/**
 * `mwops health fix <check>` — apply the mechanical repair for one check.
 *
 * The plan is built and proven before anything is written, so `--dry-run` reports exactly what the write would do. A
 * plan carrying a specifier with no proven replacement is refused by `applyModuleMoves`, which is why this function has
 * no force flag to offer.
 */
async function runFix(
	targets: readonly string[],
	options: Record<string, string | boolean>,
	io: DispatchIO
): Promise<number> {
	const id = targets[0]
	const fix = id ? findFix(id) : undefined

	if (!fix) {
		io.stderr(
			`mwops health fix: no fix for ${JSON.stringify(id ?? "")}; registered: ${fixes.map((entry) => entry.id).join(", ") || "(none)"}\n`
		)

		return 2
	}

	const dryRun = options["dry-run"] === true
	const passes: Array<{ moves: number; rewrites: number; manifests: number; literals: number; verified: number }> = []

	// A fix can create work for itself: moving `build-outlier-oa.ts` into `build/` leaves `outlier-oa.ts` beside two
	// siblings that now share `outlier-`. So the plan is re-taken until the check has nothing left to say. The bound is
	// a guard against a rule that never settles, not an expected number of passes — the repository's deepest family
	// took two.
	for (let pass = 0; pass < MAXIMUM_FIX_PASSES; pass++) {
		const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
		const moves = await fix.plan(context)

		if (!moves.length) break

		const plan = await planModuleMoves(context, moves)
		const result = await applyModuleMoves(context, plan, { dryRun })

		passes.push({
			moves: plan.moves.length,
			rewrites: plan.rewrites.length,
			manifests: plan.manifestRewrites.length,
			literals: plan.pathLiterals.length,
			verified: result.verified,
		})

		if (options.json !== true) {
			io.stdout(
				`${fix.id} pass ${pass + 1}: ${plan.moves.length} move(s), ${plan.rewrites.length} specifier rewrite(s), ${plan.manifestRewrites.length} manifest target(s), ${plan.pathLiterals.length} path literal(s), across ${plan.scanned.read} of ${plan.scanned.tracked} tracked sources\n`
			)

			for (const move of plan.moves) {
				io.stdout(`    ${move.from} -> ${move.to}\n`)
			}

			for (const rewrite of plan.rewrites) {
				io.stdout(`    ${rewrite.file}: ${rewrite.specifier} -> ${rewrite.replacement}\n`)
			}
		}

		// A dry run changes nothing, so a second pass would plan the same moves forever.
		if (dryRun) break
	}

	if (options.json === true) {
		io.stdout(`${JSON.stringify({ id: fix.id, dryRun, passes }, null, 2)}\n`)

		return 0
	}

	if (!passes.length) {
		io.stdout(`${fix.id}: nothing to move\n`)

		return 0
	}

	const verified = passes.reduce((total, pass) => total + pass.verified, 0)

	io.stdout(
		dryRun
			? "Nothing written. Drop --dry-run to apply.\n"
			: `Verified ${verified} rewritten specifier(s) against the moved tree over ${passes.length} pass(es). Next: yarn typecheck:tests\n`
	)

	return 0
}

async function runHealth(args: readonly string[], io: DispatchIO): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	if (id === "baseline") return await runBaseline(rest.slice(1), options, io)

	if (id === "fix") return await runFix(rest.slice(1), options, io)

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
			return await runOperation("release", operations, rest, io)
		case "shop":
			return await runOperation("shop", shopOperations, rest, io)
		case "health":
			return await runHealth(rest, io)
		default:
			return usage(io)
	}
}
