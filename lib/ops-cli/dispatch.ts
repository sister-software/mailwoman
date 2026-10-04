/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `mwops` routes release, shop, storage, and health operations through their registries.
 *   The `ci-scope` command selects CI suites and writes GitHub Actions outputs.
 *   Dispatch receives its output streams and checkout path from the entry point.
 *
 *   `health` also performs two mutations outside the check registry. Its type admits no writer:
 *   `health baseline debt` rewrites `lib/repo-health/baseline.json`, and `health fix <check>` applies a
 *   check's mechanical repair.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { filesAtRef, renamesSince } from "@mailwoman/core/git"
import { parseJSONStrict, prettyJSON, stringifyJSON } from "@mailwoman/core/json"
import { findOperation, type Operation, type OperationContext } from "@mailwoman/core/scripting"
import { shopOperations } from "@mailwoman/license-worker/shop/operations"
import { resolvePath } from "path-ts"

import { operations, type ReleaseContext } from "#release-kit"
import {
	applyModuleMoves,
	checkPassed,
	checks,
	DEFAULT_TRIAGE_DATABASE,
	findCheck,
	findFix,
	fixes,
	planModuleMoves,
	runCommentInventory,
	type Diagnostic,
	type ManifestReplacement,
	type ModuleMove,
	type RepoContext,
	writeBaseline,
} from "#repo-health"
import { writeCIScope } from "#repo-health/actions-output"
import { planPathLiteralRewrites } from "#repo-health/move/literals"
import { storageOperations, type StorageContext } from "#storage-kit"

/**
 * How many times `health fix` re-takes a plan before giving up.
 * See {@link runFix} for why one pass is not enough.
 */
const MAXIMUM_FIX_PASSES = 8

export interface DispatchIO {
	stdout: (text: string) => void
	stderr: (text: string) => void
	repoRoot: string
	trackedFiles: () => Promise<readonly string[]>
	/**
	 * Whether the process holds root, resolved by the bin wrapper so dispatch stays free of `process`.
	 */
	root?: boolean
}

/**
 * `--key value` and `--flag` pairs into an object the operation's `inputSchema` coerces
 * and validates, so values stay strings here and the schema decides the type.
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
			"  mwops ci-scope                   (select CI suites and write GitHub Actions outputs)",
			"  mwops health baseline debt        (rewrite lib/repo-health/baseline.json from the current readings)",
			"  mwops health fix <check> [--dry-run] [--json]",
			"  mwops health move <from> <to> [<from> <to> …] [--dry-run]   (or --moves <file.json> listing {from, to})",
			"  mwops health move --literals-since <ref> [--dry-run]   (rewrite path literals left stale by renames since <ref>)",
			"  mwops health comments [path]      (rebuild the source-comment inventory and its review leads)",
			"  mwops storage <operation> [--json] [--dry-run] [--key value …]",
			"",
			`release operations: ${operations.length ? operations.map((operation) => `${operation.id} (${operation.effect})`).join(", ") : "(none registered yet)"}`,
			`shop operations:    ${shopOperations.map((operation) => `${operation.id} (${operation.effect})`).join(", ")}`,
			`health checks:      ${checks.length ? checks.map((check) => check.id).join(", ") : "(none registered yet)"}`,
			`health fixes:       ${fixes.length ? fixes.map((fix) => fix.id).join(", ") : "(none registered yet)"}`,
			// oxlint-disable-next-line maishopViewlwoman/comment-reflow -- TODO Detangle this
			// `storage operations: ${storageOperations.map((operation) => `${operation.id} (${operation.effect})`).join(", ")}`,
			"",
		].join("\n")
	)

	return 2
}

/**
 * One registry as a `mwops` verb: its operations and the context each receives.
 *
 * The registry also defines how an output determines the exit code.
 */
interface OperationView<TContext extends OperationContext> {
	verb: string
	registry: ReadonlyArray<Operation<string, TContext>>
	context: (base: OperationContext, io: DispatchIO) => TContext
	/**
	 * The exit code an output earns.
	 * A view without one exits 0.
	 */
	exitCode?: (output: unknown) => number
}

const releaseView: OperationView<ReleaseContext> = {
	verb: "release",
	registry: operations,
	context: (base, io) => ({ ...base, repoRoot: io.repoRoot }),
}

const shopView: OperationView<ReleaseContext> = {
	verb: "shop",
	registry: shopOperations,
	context: (base, io) => ({ ...base, repoRoot: io.repoRoot }),
}

const storageView: OperationView<StorageContext> = {
	verb: "storage",
	registry: storageOperations,
	context: (base, io) => ({ ...base, root: io.root ?? false }),
	// A verify that found failures exits non-zero, so a caller can branch on the status.
	exitCode: (output) => {
		const failed = (output as { failed?: number }).failed

		return typeof failed === "number" && failed > 0 ? 1 : 0
	},
}

/**
 * Run one operation of a registry, found by its bare name or dotted id.
 */
async function runOperation<TContext extends OperationContext>(
	view: OperationView<TContext>,
	args: readonly string[],
	io: DispatchIO
): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	const operation = findOperation(view.registry, view.verb, id)

	if (!operation) {
		io.stderr(
			`mwops ${view.verb}: no operation ${stringifyJSON(id)}; registered: ${view.registry.map((o) => o.id).join(", ") || "(none)"}\n`
		)

		return 2
	}

	const json = options.json === true

	const context = view.context(
		{
			dryRun: options["dry-run"] === true,
			log: json ? () => {} : (line) => io.stderr(`${line}\n`),
		},
		io
	)

	const { json: _json, "dry-run": _dryRun, ...input } = options
	const parsed = operation.inputSchema.safeParse(input)

	if (!parsed.success) {
		io.stderr(`mwops ${view.verb} ${operation.id}: invalid input — ${parsed.error.message}\n`)

		return 2
	}

	const output = await operation.run(parsed.data, context)

	const renderedOutput = json
		? prettyJSON(output)
		: operation.formatOutput
			? operation.formatOutput(output)
			: String(output === undefined ? "ok" : prettyJSON(output))

	io.stdout(`${renderedOutput}\n`)

	return view.exitCode?.(output) ?? 0
}

/**
 * `mwops health baseline <counter-set>` — rewrite a baseline from the current readings,
 * where `debt` is the only counter set.
 */
async function runBaseline(
	targets: readonly string[],
	options: Record<string, string | boolean>,
	io: DispatchIO
): Promise<number> {
	const target = targets[0]

	if (target !== "debt") {
		io.stderr(`mwops health baseline: no baseline ${stringifyJSON(target ?? "")}; the one that exists is "debt"\n`)

		return 2
	}

	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
	const written = await writeBaseline(context)

	if (options.json === true) {
		io.stdout(prettyJSON(written))
	} else {
		for (const [name, count] of Object.entries(written.counters)) {
			io.stdout(`${name}: ${count}\n`)
		}

		io.stdout(`Updated ${written.file}\n`)
	}

	return 0
}

/**
 * `mwops health comments [path]` — rebuild the source-comment inventory and its heuristic
 * review leads, a report about the tree rather than a verdict on it.
 */
async function runComments(
	targets: readonly string[],
	options: Record<string, string | boolean>,
	io: DispatchIO
): Promise<number> {
	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
	const report = await runCommentInventory(context, targets[0] ?? DEFAULT_TRIAGE_DATABASE)

	if (options.json === true) {
		io.stdout(prettyJSON(report))
	} else {
		io.stdout(`${report.comments} comment(s) and ${report.leads} lead(s) over ${report.files} file(s)\n`)
		io.stdout(`Wrote ${report.databasePath}\n`)
	}

	return 0
}

/**
 * `mwops health fix <check>` — apply the mechanical repair for one check, building and proving
 * the plan before anything is written so `--dry-run` reports exactly what the write would do.
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
			`mwops health fix: no fix for ${stringifyJSON(id ?? "")}; registered: ${fixes.map((entry) => entry.id).join(", ") || "(none)"}\n`
		)

		return 2
	}

	const dryRun = options["dry-run"] === true

	const passes: Array<{
		moves: number
		rewrites: number
		manifests: number
		replacements: number
		literals: number
		verified: number
	}> = []

	// A fix can create work for itself, so the plan is re-taken until the check has no further finding.
	// The bound guards a rule that never settles.
	for (let pass = 0; pass < MAXIMUM_FIX_PASSES; pass++) {
		const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
		const proposed = await fix.plan(context)

		if (!proposed.moves.length && !proposed.manifests?.length) break

		const plan = await planModuleMoves(context, proposed.moves, { manifests: proposed.manifests })
		const result = await applyModuleMoves(context, plan, { dryRun })

		passes.push({
			moves: plan.moves.length,
			rewrites: plan.rewrites.length,
			manifests: plan.manifestRewrites.length,
			replacements: plan.manifestReplacements.length,
			literals: plan.pathLiterals.length,
			verified: result.verified,
		})

		if (options.json !== true) {
			io.stdout(
				`${fix.id} pass ${pass + 1}: ${plan.moves.length} move(s), ${plan.rewrites.length} specifier rewrite(s), ${plan.manifestRewrites.length} manifest target(s), ${plan.manifestReplacements.length} manifest replacement(s), ${plan.pathLiterals.length} path literal(s), across ${plan.scanned.read} of ${plan.scanned.tracked} tracked sources\n`
			)

			for (const move of plan.moves) {
				io.stdout(`    ${move.from} -> ${move.to}\n`)
			}

			for (const rewrite of plan.rewrites) {
				io.stdout(`    ${rewrite.file}: ${rewrite.specifier} -> ${rewrite.replacement}\n`)
			}
		}

		// A dry run makes no change, so a second pass would plan the same moves forever.
		if (dryRun) break
	}

	if (options.json === true) {
		io.stdout(prettyJSON({ id: fix.id, dryRun, passes }))

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

/**
 * `mwops health move --literals-since <ref>` — rewrite the path literals that
 * every rename since `ref` left stale.
 *
 * The renames come from `git diff --name-status -M <ref>`, and directory renames are judged against
 * the files `ref` tracked, so a directory counts as moved only when all of its files moved together.
 */
async function runLiteralRepair(ref: string, dryRun: boolean, io: DispatchIO): Promise<number> {
	const renames: ModuleMove[] = await renamesSince(ref, io.repoRoot)
	const refFiles = await filesAtRef(ref, io.repoRoot)
	const pathLiterals = await planPathLiteralRewrites(io.repoRoot, refFiles, renames)
	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }

	await applyModuleMoves(
		context,
		{
			moves: [],
			rewrites: [],
			manifestRewrites: [],
			manifestReplacements: [],
			pathLiterals,
			unresolved: [],
			scanned: { read: refFiles.length, tracked: refFiles.length },
		},
		{ dryRun }
	)

	io.stdout(`literals: ${pathLiterals.length} stale path literal(s) from ${renames.length} rename(s) since ${ref}\n`)

	for (const literal of pathLiterals) {
		io.stdout(`    ${literal.file}: ${literal.path} -> ${literal.replacement}\n`)
	}

	io.stdout(dryRun ? "Nothing written. Drop --dry-run to apply.\n" : "Rewritten.\n")

	return 0
}

/**
 * The `--moves` file: a list of `{from, to}` pairs, or an object that also names replacement manifests.
 *
 * Each manifest entry gives the repo-relative `package.json` to replace
 * and the file holding its new text, so a move into a new source root is planned
 * against the `imports` and `exports` keys that reach it.
 */
type MoveFile = ModuleMove[] | { moves: ModuleMove[]; manifests?: Array<{ file: string; from: string }> }

/**
 * `mwops health move` — move modules named on the command line or in a JSON file of `{from, to}`
 * pairs, rewriting every specifier, manifest target and path literal the move invalidates.
 *
 * The plan is proven before anything is written, as with `health fix`.
 */
async function runMove(
	targets: readonly string[],
	options: Record<string, string | boolean>,
	io: DispatchIO
): Promise<number> {
	let moves: ModuleMove[]
	const manifests: ManifestReplacement[] = []

	if (typeof options["literals-since"] === "string") {
		return await runLiteralRepair(options["literals-since"], options["dry-run"] === true, io)
	}

	if (typeof options.moves === "string") {
		const parsed = parseJSONStrict<MoveFile>(await readLocalTextFile(resolvePath(io.repoRoot, options.moves)))

		moves = Array.isArray(parsed) ? parsed : parsed.moves

		for (const manifest of Array.isArray(parsed) ? [] : (parsed.manifests ?? [])) {
			manifests.push({
				file: manifest.file,
				text: await readLocalTextFile(resolvePath(io.repoRoot, manifest.from)),
			})
		}
	} else {
		if (!targets.length || targets.length % 2) {
			io.stderr("mwops health move: give <from> <to> pairs, or --moves <file.json>\n")

			return 2
		}

		moves = []

		for (let index = 0; index < targets.length; index += 2) {
			moves.push({ from: targets[index]!, to: targets[index + 1]! })
		}
	}

	const dryRun = options["dry-run"] === true
	const context: RepoContext = { repoRoot: io.repoRoot, trackedFiles: await io.trackedFiles() }
	const plan = await planModuleMoves(context, moves, { manifests })
	const result = await applyModuleMoves(context, plan, { dryRun })

	if (options.json === true) {
		io.stdout(prettyJSON(result))

		return 0
	}

	io.stdout(
		`move: ${plan.moves.length} move(s), ${plan.rewrites.length} specifier rewrite(s), ${plan.manifestRewrites.length} manifest target(s), ${plan.pathLiterals.length} path literal(s), across ${plan.scanned.read} of ${plan.scanned.tracked} tracked sources\n`
	)

	for (const rewrite of plan.rewrites) {
		io.stdout(`    ${rewrite.file}: ${rewrite.specifier} -> ${rewrite.replacement}\n`)
	}

	io.stdout(
		dryRun
			? "Nothing written. Drop --dry-run to apply.\n"
			: `Verified ${result.verified} rewritten specifier(s) against the moved tree. Next: yarn typecheck:tests\n`
	)

	return 0
}

async function runHealth(args: readonly string[], io: DispatchIO): Promise<number> {
	const { options, rest } = parseOptions(args)
	const id = rest[0]

	if (!id) return usage(io)

	if (id === "baseline") return await runBaseline(rest.slice(1), options, io)

	if (id === "fix") return await runFix(rest.slice(1), options, io)

	if (id === "move") return await runMove(rest.slice(1), options, io)

	if (id === "comments") return await runComments(rest.slice(1), options, io)

	const selected = id === "all" ? checks : [findCheck(id)].filter((check) => check !== undefined)

	if (id === "all" && !checks.length) {
		io.stdout(options.json === true ? "[]\n" : "no health checks registered yet\n")

		return 0
	}

	if (!selected.length) {
		io.stderr(
			`mwops health: no check ${stringifyJSON(id)}; registered: ${checks.map((c) => c.id).join(", ") || "(none)"}\n`
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
		io.stdout(prettyJSON(results))
	} else {
		for (const result of results) {
			io.stdout(`${result.passed ? "✓" : "✗"} ${result.id}\n`)

			for (const diagnostic of result.diagnostics) {
				io.stdout(
					`    ${diagnostic.severity}: ${diagnostic.message}${diagnostic.file ? ` (${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""})` : ""}\n`
				)

				for (const detail of diagnostic.details ?? []) {
					io.stdout(`        ${detail}\n`)
				}
			}
		}
	}

	return results.every((result) => result.passed) ? 0 : 1
}

/**
 * Route one invocation.
 *
 * @returns The exit code.
 */
export async function dispatch(args: readonly string[], io: DispatchIO): Promise<number> {
	const [verb, ...rest] = args

	switch (verb) {
		case "ci-scope":
			io.stdout(prettyJSON(await writeCIScope(io.repoRoot)))
			return 0
		case "release":
			return await runOperation(releaseView, rest, io)
		case "shop":
			return await runOperation(shopView, rest, io)
		case "health":
			return await runHealth(rest, io)
		case "storage":
			return await runOperation(storageView, rest, io)
		default:
			return usage(io)
	}
}
