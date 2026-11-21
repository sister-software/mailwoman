// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   The effects report: one page per workspace, plus an index, listing each module's
 *   import-time effects, its runtime effect edges and the state machines it declares.
 *
 *   The report is computed from the tree on request, by `yarn mwops effects`.
 *   The repository keeps no copy of it.
 *
 *   A committed copy conflicted between branches and went stale on the default branch.
 *   A pull request's effect changes come from {@linkcode diffEffects} over two checkouts.
 *
 *   The edges come from {@linkcode extractEffectEdges} and the import-time
 *   effects from {@linkcode importTimeEffects}.
 *   The effect census and the `side-effects` check call the same two readers.
 *
 *   A module's edges are grouped by kind, interface and target with a count, and the rows
 *   hold no line numbers, so an edit that only moves an effect leaves the page as it was.
 *   A machine's transition table comes from importing its module and applying
 *   each of its `events` to each of its states.
 *
 *   Test sources and the shared helpers under a `test/` directory are left out.
 *   Test selection reads their edges from the census itself.
 */

import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import type { MachineEffect, StateMachine } from "@mailwoman/core/state-machine"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { type PathBuilderLike, relative, resolvePath } from "path-ts"
import { parallelMap } from "spliterator"

import type { RepoContext } from "#repo-health/check"
import { importTimeEffects, sideEffectsListing } from "#repo-health/checks/side-effects"
import { isTestSource } from "#repo-health/ci/runtime-reads"
import { parseContextSource } from "#repo-health/context"
import { censusGroupOf, readImportedPaths } from "#repo-health/effects/census"
import { type EffectEdge, extractEffectEdges } from "#repo-health/effects/extract"
import { EffectKind } from "#repo-health/effects/interfaces"
import { trackedSourcePaths } from "#repo-health/tracked-sources"

/**
 * The index page's file name in a written report.
 */
const INDEX_PAGE = "index.md"

/**
 * The module that defines the machine helper.
 * It mentions `defineStateMachine` and declares no machine.
 */
const MACHINE_HELPER = "packages/core/lib/state-machine.ts"

/**
 * A call to the helper, with or without type arguments: `defineStateMachine(` or `defineStateMachine<…>(`.
 */
const MACHINE_CALL = /\bdefineStateMachine\s*[<(]/u

const KIND_ORDER: readonly EffectKind[] = [
	EffectKind.Read,
	EffectKind.Write,
	EffectKind.Network,
	EffectKind.Process,
	EffectKind.Environment,
]

/**
 * One generated page: its path relative to the repository root and its MDX source.
 */
interface RegisterPage {
	/**
	 * The page's file name in a written report.
	 */
	path: string
	/**
	 * The workspace group the page covers, or `null` for the index.
	 */
	group: string | null
	markdown: string
}

interface ModuleEntry {
	file: string
	edges: EffectEdge[]
	importTime: string[]
	declaresMachine: boolean
}

interface MachineEntry {
	file: string
	exportName: string
	machine: StateMachine<string, unknown, object, MachineEffect>
}

/**
 * A value as an inline code span, with its backticks replaced so the span stays one span.
 */
function code(value: string): string {
	return `\`${value.replaceAll("`", "'").replaceAll("\n", " ")}\``
}

/**
 * A group's page file name in a written report.
 */
function pageOf(group: string): string {
	return `${group.replaceAll("/", "-")}.md`
}

function targetOf(edge: EffectEdge): string {
	if (edge.target) return `${edge.target.root}:${edge.target.path}`

	return `unresolved (${edge.unresolvedShape ?? "other"})`
}

function isMachine(value: unknown): value is StateMachine<string, unknown, object, MachineEffect> {
	if (typeof value !== "object" || value == null) return false

	const candidate = value as Partial<StateMachine<string, unknown>>

	return (
		typeof candidate.name === "string" && Array.isArray(candidate.states) && typeof candidate.transition === "function"
	)
}

/**
 * The machines a module exports, in export order.
 */
async function machinesOf(context: RepoContext, file: string): Promise<MachineEntry[]> {
	const module = (await import(resolvePath(context.repoRoot, file).toString())) as Record<string, unknown>

	return Object.entries(module)
		.filter((entry): entry is [string, StateMachine<string, unknown, object, MachineEffect>] => isMachine(entry[1]))
		.map(([exportName, machine]) => ({ file, exportName, machine }))
}

/**
 * The tracked library and tool modules, each with its edges, import-time effects
 * and whether it calls the helper.
 */
async function collectModules(context: RepoContext, onlyGroup: string | null = null): Promise<ModuleEntry[]> {
	const paths = (await trackedSourcePaths(context, { existingOnly: true })).filter((path) => {
		const file = relative(context.repoRoot, path).toString()

		// A lookup of one group parses that group's modules and no others.
		if (onlyGroup != null && groupOf(file) !== onlyGroup) return false

		return !isTestSource(file) && !/(?:^|\/)test\//u.test(file)
	})

	const importedPathsOf = await readImportedPaths(context)

	return parallelMap(paths, async (path): Promise<ModuleEntry> => {
		const source = await parseContextSource(context, path, { setParentNodes: true })
		const file = relative(context.repoRoot, path).toString()

		return {
			file,
			edges: extractEffectEdges(source, file, importedPathsOf(file)),
			// The statement snippet after the colon changes with each edit to the statement, so the page keeps the category.
			importTime: importTimeEffects(source, file).map((effect) => effect.what.split(": ")[0]!),
			declaresMachine: file !== MACHINE_HELPER && MACHINE_CALL.test(source.text),
		}
	})
		.toArray()
		.then((modules) => modules.toSorted((a, b) => a.file.localeCompare(b.file)))
}

/**
 * Each group's `sideEffects` listing, read from the manifest of the workspace that holds the group.
 *
 * A group outside every workspace directory, such as `lib`, belongs to the root manifest.
 */
async function listingsOf(
	context: RepoContext,
	groups: readonly string[]
): Promise<Map<string, { workspace: string; declared: boolean | readonly string[] | undefined }>> {
	const workspaces = new Set(await readWorkspaceDirectories(context.repoRoot))
	const listings = new Map<string, { workspace: string; declared: boolean | readonly string[] | undefined }>()

	for (const group of groups) {
		const workspace = workspaces.has(group) ? group : "."

		const manifest = (await readPackageJSON(resolvePath(context.repoRoot, workspace, "package.json"))) as {
			sideEffects?: boolean | readonly string[]
		}

		listings.set(group, { workspace, declared: manifest.sideEffects })
	}

	return listings
}

/**
 * A manifest's `sideEffects` declaration, written as the predicate of a sentence
 * whose subject is the manifest.
 */
function declarationText(declared: boolean | readonly string[] | undefined): string {
	if (declared === false) return "declares `sideEffects: false`"

	if (Array.isArray(declared)) return `declares a \`sideEffects\` list of ${declared.length}`

	return declared === true ? "declares `sideEffects: true`" : "has no `sideEffects` field"
}

/**
 * The sentences that say which of a group's modules the page lists.
 *
 * They state no count of modules.
 * A count changes whenever a module is added to the workspace, with or without an effect,
 * and two branches that each add one would then change the same line.
 */
function coverageText(listsAny: boolean): string[] {
	if (!listsAny) {
		return ["None of the group's library and tool modules holds an effect edge or an import-time effect."]
	}

	return [
		"This page lists the group's library and tool modules that hold an effect edge or an import-time effect.",
		`[The index](./${INDEX_PAGE}) explains the columns.`,
	]
}

/**
 * One module's effects as plain lines, one per import-time effect category
 * and one per edge row, each with the count of its occurrences.
 *
 * {@linkcode diffEffects} compares two readings of a module line by line.
 */
function effectLines(module: ModuleEntry): string[] {
	const importTime = Map.groupBy(module.importTime, (what) => what)
		.entries()
		.map(([what, found]) => `import-time: ${what}${found.length > 1 ? ` ×${found.length}` : ""}`)

	return [
		...importTime,
		...edgeRowsOf(module.edges).map((row) => `${row.kind}: ${row.name} → ${row.target} ×${row.count}`),
	]
}

interface EdgeRow {
	kind: EffectKind
	name: string
	target: string
	count: number
}

/**
 * A module's edges grouped by kind, interface and target, each with the count of its calls.
 */
function edgeRowsOf(edges: readonly EffectEdge[]): EdgeRow[] {
	const counts = new Map<string, EdgeRow>()

	for (const edge of edges) {
		const target = targetOf(edge)
		const key = `${edge.kind}\u0000${edge.interface}\u0000${target}`
		const row = counts.get(key)

		if (row) {
			row.count++
		} else {
			counts.set(key, { kind: edge.kind, name: edge.interface, target, count: 1 })
		}
	}

	return [...counts.values()].toSorted(
		(a, b) =>
			KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
			a.name.localeCompare(b.name) ||
			a.target.localeCompare(b.target)
	)
}

function edgeRows(edges: readonly EffectEdge[]): string[] {
	return edgeRowsOf(edges).map((row) => `| ${row.kind} | ${code(row.name)} | ${code(row.target)} | ${row.count} |`)
}

function workspacePage(
	group: string,
	modules: readonly ModuleEntry[],
	listing: { workspace: string; declared: boolean | readonly string[] | undefined }
): RegisterPage {
	const lists = sideEffectsListing(listing.declared)
	const declaresList = listing.declared === false || Array.isArray(listing.declared)
	const workspaceRoot = listing.workspace === "." ? "" : `${listing.workspace}/`
	const shown = modules.filter((module) => module.edges.length || module.importTime.length)

	const lines = [
		`# Effects of ${code(group)}`,
		"",
		`The manifest at ${code(`${workspaceRoot}package.json`)} ${declarationText(listing.declared)}.`,
		...coverageText(shown.length > 0),
	]

	for (const module of shown) {
		const listed = lists(module.file.slice(workspaceRoot.length))

		const status = !declaresList
			? "The manifest marks no module side-effect-free, so a bundler keeps this one."
			: listed
				? "The workspace's `sideEffects` declaration lists this module."
				: "The workspace's `sideEffects` declaration leaves this module out."

		lines.push("", `## ${code(module.file)}`, "")

		if (module.importTime.length) {
			lines.push(
				`${status} Its import-time effects:`,
				"",
				...Map.groupBy(module.importTime, (what) => what)
					.entries()
					.map(([what, found]) => `- ${code(what)}${found.length > 1 ? `, ${found.length} times` : ""}`),
				""
			)
		}

		if (module.edges.length) {
			lines.push("| Kind | Interface | Target | Calls |", "| --- | --- | --- | --- |", ...edgeRows(module.edges))
		}
	}

	return { path: pageOf(group), group, markdown: `${lines.join("\n")}\n` }
}

function machineSection(entry: MachineEntry): string[] {
	const { machine } = entry
	const events = Object.entries(machine.events ?? {})

	const lines = [
		"",
		`### ${code(machine.name)}`,
		"",
		`${code(entry.exportName)} in ${code(entry.file)} has ${machine.states.length} states: ${machine.states.map(code).join(", ")}.`,
	]

	if (!events.length) {
		lines.push("", "Its definition lists no example events, so its transition table is left out.")

		return lines
	}

	const effects = new Set<string>()

	lines.push(
		"",
		`| From | ${events.map(([label]) => label).join(" | ")} |`,
		`| --- | ${events.map(() => "---").join(" | ")} |`
	)

	for (const state of machine.states) {
		const cells = events.map(([, event]) => {
			const step = machine.transition(state, event)

			for (const effect of step.effects) {
				effects.add(`${effect.kind} (${effect.effect})`)
			}

			return code(step.next)
		})

		lines.push(`| ${code(state)} | ${cells.join(" | ")} |`)
	}

	lines.push(
		"",
		effects.size
			? `Its steps run these effects: ${[...effects].toSorted().map(code).join(", ")}.`
			: "Its steps describe zero effects."
	)

	return lines
}

function indexPage(groups: ReadonlyMap<string, ModuleEntry[]>, machines: readonly MachineEntry[]): RegisterPage {
	const lines = [
		"# Effects",
		"",
		"Each workspace has a page listing its library and tool modules. A module appears when it holds an effect edge or an import-time effect.",
		"`yarn mwops effects <workspace directory or module path>` prints one page or one module, read from the source as it is now.",
		"",
		"An import-time effect is work a module does when it is evaluated, as `packages/core/AGENTS.md` defines it.",
		"The `side-effects` check reports one that a workspace's `sideEffects` declaration leaves out.",
		"",
		"An effect edge is one call to a registered effect interface: a read, write, network call, process launch or environment read.",
		"Its target is a path root and a path when the extractor resolves the argument, written `<root>:<path>`.",
		"Otherwise the target reads `unresolved`, with the shape of the argument: a `parameter` of the enclosing function, a local `identifier`, a `property`, a `call`, a `template` or `other`.",
		"Calls with the same kind, interface and target share one row and are counted.",
		"",
		"## Workspaces",
		"",
	]

	for (const group of groups.keys()) {
		lines.push(`- [${code(group)}](./${pageOf(group)})`)
	}

	lines.push(
		"",
		"## State machines",
		"",
		"A state machine is declared with `defineStateMachine` from `@mailwoman/core/state-machine`.",
		"In each transition table, a cell holds the state the transition moves to from the row's state on the column's example event.",
		"The `state-column-writes` check reports an update of a `_state` column that skips comparing the state it moves from.",
		...machines.flatMap(machineSection)
	)

	return { path: INDEX_PAGE, group: null, markdown: `${lines.join("\n")}\n` }
}

/**
 * The group a module's page belongs to.
 *
 * The configuration files at the repository root share one group.
 */
function groupOf(file: string): string {
	return file.includes("/") ? censusGroupOf(file) : "root"
}

/**
 * Writes every page under `directory`, and returns the count written.
 *
 * The pages are a report of the tree as it is now.
 * The repository keeps no copy of them, because a copy conflicts between branches and goes stale.
 */
export async function writeEffectsPages(context: RepoContext, directory: PathBuilderLike): Promise<number> {
	const pages = await renderEffectsPages(context)

	for (const page of pages) {
		await writeLocalTextFile(page.markdown, resolvePath(directory, page.path))
	}

	return pages.length
}

/**
 * The page or the module section that `target` selects, or `null` when it selects neither.
 *
 * A workspace directory such as `packages/earth` selects that group's page.
 * A module path selects that module's section of its group's page.
 * An absent target selects the index.
 */
export async function effectsOf(context: RepoContext, target: string | null): Promise<string | null> {
	if (target == null) {
		return (await renderEffectsPages(context)).find((page) => page.group === null)!.markdown
	}

	const normalized = target.replace(/\/+$/u, "")
	// A target with a source extension is a module, and any other target is a group's directory.
	const group = /\.[cm]?[jt]sx?$/u.test(normalized) ? groupOf(normalized) : normalized
	const pages = await renderEffectsPages(context, group)
	const page = pages.find((entry) => entry.group === normalized)

	if (page) return page.markdown

	const heading = `## ${code(normalized)}\n`
	const owner = pages.find((entry) => entry.group === groupOf(normalized))
	const start = owner?.markdown.indexOf(heading) ?? -1

	if (!owner || start < 0) return null

	const end = owner.markdown.indexOf("\n## ", start + heading.length)

	return `${owner.markdown.slice(start, end === -1 ? undefined : end).trimEnd()}\n`
}

/**
 * Each module's effects as plain lines, keyed by the module's path, for the modules that hold any.
 *
 * It reads sources and manifests only and imports no module, so it can read a
 * second checkout that has no install of its own.
 */
export async function effectsSnapshot(context: RepoContext): Promise<Map<string, string[]>> {
	const modules = await collectModules(context)

	return new Map(
		modules
			.map((module): [string, string[]] => [module.file, effectLines(module)])
			.filter(([, lines]) => lines.length > 0)
	)
}

/**
 * One module whose effects differ between two snapshots.
 */
export interface EffectDifference {
	file: string
	added: string[]
	removed: string[]
}

/**
 * The modules whose effect lines differ between `base` and `head`, by path.
 *
 * A module that moved reads as its lines removed at the old path and added at the new one.
 */
export function diffEffects(
	base: ReadonlyMap<string, readonly string[]>,
	head: ReadonlyMap<string, readonly string[]>
): EffectDifference[] {
	const files = [...new Set([...base.keys(), ...head.keys()])].toSorted()

	return files
		.map((file) => {
			const before = new Set(base.get(file))
			const after = new Set(head.get(file))

			return {
				file,
				added: [...after].filter((line) => !before.has(line)),
				removed: [...before].filter((line) => !after.has(line)),
			}
		})
		.filter((difference) => difference.added.length + difference.removed.length > 0)
}

/**
 * A difference as Markdown for a pull request's job summary.
 */
export function formatEffectDifferences(differences: readonly EffectDifference[]): string {
	if (!differences.length) return "## Effect changes\n\nThis change adds and removes zero effects.\n"

	const lines = ["## Effect changes", ""]

	for (const { file, added, removed } of differences) {
		lines.push(`### ${code(file)}`, "", ...added.map((line) => `- added: ${code(line)}`))
		lines.push(...removed.map((line) => `- removed: ${code(line)}`), "")
	}

	return `${lines.join("\n")}\n`
}

/**
 * Every page, the index first.
 */
async function renderEffectsPages(context: RepoContext, onlyGroup: string | null = null): Promise<RegisterPage[]> {
	const modules = await collectModules(context, onlyGroup)
	const groups = new Map<string, ModuleEntry[]>()

	for (const module of modules) {
		const group = groupOf(module.file)

		groups.set(group, [...(groups.get(group) ?? []), module])
	}

	const sorted = new Map([...groups].toSorted(([a], [b]) => a.localeCompare(b)))
	const listings = await listingsOf(context, [...sorted.keys()])

	const machines: MachineEntry[] = []

	for (const module of modules) {
		if (module.declaresMachine) {
			machines.push(...(await machinesOf(context, module.file)))
		}
	}

	// A module namespace lists exports in code-point order under Node and in declaration order under Vitest.
	// The index sorts the machines itself, so both runs print the same order.
	machines.sort((a, b) => a.machine.name.localeCompare(b.machine.name) || a.file.localeCompare(b.file))

	return [
		indexPage(sorted, machines),
		...[...sorted].map(([group, entries]) => workspacePage(group, entries, listings.get(group)!)),
	]
}
