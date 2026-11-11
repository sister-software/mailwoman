/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The effects register: one generated reference page per workspace, plus an index, listing each module's import-time
 *   effects, its runtime effect edges and the state machines it declares.
 *
 *   The edges come from {@linkcode extractEffectEdges} and the import-time effects from {@linkcode importTimeEffects}.
 *   The effect census and the `side-effects` check call the same two readers. A module's edges are grouped by kind, interface and
 *   target with a count, and the rows hold no line numbers, so an edit that only moves an effect leaves the page as it
 *   was. A machine's transition table comes from importing its module and applying each of its `events` to each of its
 *   states.
 *
 *   Test sources and the shared helpers under a `test/` directory are left out. Test selection reads their edges from
 *   the census itself.
 */

import { readLocalTextFile, sortedGlob } from "@mailwoman/core/fs/readers"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { removeFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import type { MachineEffect, StateMachine } from "@mailwoman/core/state-machine"
import { readWorkspaceDirectories } from "@mailwoman/core/workspaces"
import { type FormatConfig, format } from "oxfmt"
import { relative, resolvePath } from "path-ts"
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
 * The index page, relative to the repository root.
 */
const EFFECTS_REGISTER_INDEX = "docs/engineering/reference/effects-register.mdx"

/**
 * The directory that holds one page per workspace, relative to the repository root.
 */
const EFFECTS_REGISTER_DIRECTORY = "docs/engineering/reference/effects-register"

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
export interface RegisterPage {
	path: string
	mdx: string
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

function slugOf(group: string): string {
	return group.replaceAll("/", "-")
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
async function collectModules(context: RepoContext): Promise<ModuleEntry[]> {
	const paths = (await trackedSourcePaths(context, { existingOnly: true })).filter((path) => {
		const file = relative(context.repoRoot, path).toString()

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

function declarationText(declared: boolean | readonly string[] | undefined): string {
	if (declared === false) return "`sideEffects: false`"

	if (Array.isArray(declared)) return `a \`sideEffects\` list of ${declared.length}`

	return declared === true ? "`sideEffects: true`" : "an absent `sideEffects` field"
}

function edgeRows(edges: readonly EffectEdge[]): string[] {
	const counts = new Map<string, { kind: EffectKind; name: string; target: string; count: number }>()

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

	return [...counts.values()]
		.toSorted(
			(a, b) =>
				KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
				a.name.localeCompare(b.name) ||
				a.target.localeCompare(b.target)
		)
		.map((row) => `| ${row.kind} | ${code(row.name)} | ${code(row.target)} | ${row.count} |`)
}

const FRONTMATTER = (title: string, description: string) => [
	"---",
	`title: ${stringifyJSON(title)}`,
	`description: ${stringifyJSON(description)}`,
	"role: reference",
	"audience: maintainer",
	"owner: engineering",
	"---",
]

const GENERATED = "{/* Generated by `yarn mwops effects-register`. Edit lib/repo-health/effects/register.ts. */}"

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
		...FRONTMATTER(
			`Effects register: ${group}`,
			`The import-time effects and runtime effect edges of each module in ${group}.`
		),
		"",
		GENERATED,
		"",
		`# Effects register: ${code(group)}`,
		"",
		`The manifest at ${code(`${workspaceRoot}package.json`)} declares ${declarationText(listing.declared)}.`,
		`This page lists ${shown.length} of the group's ${modules.length} library and tool modules.`,
		"The others hold neither an effect edge nor an import-time effect.",
		"[The index](../effects-register.mdx) explains the columns.",
	]

	for (const module of shown) {
		const listed = lists(module.file.slice(workspaceRoot.length))

		const status = !declaresList
			? "kept by a bundler because the workspace counts every module as effectful"
			: listed
				? "listed in the workspace's `sideEffects` declaration"
				: "missing from the workspace's `sideEffects` declaration"

		lines.push("", `## ${code(module.file)}`, "")

		if (module.importTime.length) {
			lines.push(
				`Import-time effects, ${status}:`,
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

	return { path: `${EFFECTS_REGISTER_DIRECTORY}/${slugOf(group)}.mdx`, mdx: `${lines.join("\n")}\n` }
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
		"Each cell holds the state the transition moves to from the row's state on the column's example event.",
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
			: "Its steps describe zero effects. Every write is the carrier's compare-and-set."
	)

	return lines
}

function indexPage(groups: ReadonlyMap<string, ModuleEntry[]>, machines: readonly MachineEntry[]): RegisterPage {
	const lines = [
		...FRONTMATTER(
			"Effects register",
			"What each workspace's modules do when imported and when run: their reads, writes, network calls, processes and environment reads, and the state machines they declare."
		),
		"",
		GENERATED,
		"",
		"# Effects register",
		"",
		"Each workspace has a page listing its library and tool modules. A module appears when it holds an effect edge or an import-time effect.",
		"Regenerate every page with `yarn mwops effects-register`. The `effects-register` repository check compares the committed pages with the generator's output.",
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
		"| Workspace | Modules listed | Import-time effects | Read | Write | Network | Process | Environment | Unresolved |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	]

	for (const [group, modules] of groups) {
		const edges = modules.flatMap((module) => module.edges)
		const byKind = (kind: EffectKind) => edges.filter((edge) => edge.kind === kind).length
		const listed = modules.filter((module) => module.edges.length || module.importTime.length).length
		const importTime = modules.reduce((sum, module) => sum + module.importTime.length, 0)
		const unresolved = edges.filter((edge) => !edge.target).length

		lines.push(
			`| [${code(group)}](./effects-register/${slugOf(group)}.mdx) | ${listed} of ${modules.length} | ${importTime} | ` +
				`${KIND_ORDER.map(byKind).join(" | ")} | ${unresolved} |`
		)
	}

	lines.push(
		"",
		"## State machines",
		"",
		"A state machine is declared with `defineStateMachine` from `@mailwoman/core/state-machine`.",
		`The register lists ${machines.length} machines.`,
		"The `state-column-writes` check reports an update of a `_state` column that skips comparing the state it moves from.",
		...machines.flatMap(machineSection)
	)

	return { path: EFFECTS_REGISTER_INDEX, mdx: `${lines.join("\n")}\n` }
}

/**
 * The register's pages on disk: the index and every `.mdx` page in the workspace directory.
 */
async function committedPages(repoRoot: string): Promise<string[]> {
	const directory = resolvePath(repoRoot, EFFECTS_REGISTER_DIRECTORY)
	const pages = (await pathExists(directory)) ? await sortedGlob(directory, "*.mdx") : []

	return pages.map((path) => relative(repoRoot, path).toString())
}

/**
 * How the register on disk differs from the generator's output.
 */
export interface RegisterDrift {
	/**
	 * Generated pages whose file is absent or holds other text.
	 */
	stale: string[]
	/**
	 * Workspace pages on disk that the generator no longer writes.
	 */
	extra: string[]
}

/**
 * Compares the register on disk with `pages`.
 */
export async function registerDrift(repoRoot: string, pages: readonly RegisterPage[]): Promise<RegisterDrift> {
	const generated = new Set(pages.map((page) => page.path))
	const stale: string[] = []

	for (const page of pages) {
		const path = resolvePath(repoRoot, page.path)

		if (!(await pathExists(path)) || (await readLocalTextFile(path)) !== page.mdx) {
			stale.push(page.path)
		}
	}

	const extra = (await committedPages(repoRoot)).filter((path) => !generated.has(path))

	return { stale, extra }
}

/**
 * Writes every generated page and removes each workspace page the generator no longer writes.
 */
export async function writeEffectsRegister(context: RepoContext): Promise<RegisterDrift & { pages: number }> {
	const pages = await renderEffectsRegister(context)
	const drift = await registerDrift(context.repoRoot, pages)

	for (const page of pages) {
		if (drift.stale.includes(page.path)) {
			await writeLocalTextFile(page.mdx, resolvePath(context.repoRoot, page.path))
		}
	}

	for (const path of drift.extra) {
		await removeFile(resolvePath(context.repoRoot, path))
	}

	return { ...drift, pages: pages.length }
}

/**
 * Every page of the register, the index first, as the generator writes them.
 */
export async function renderEffectsRegister(context: RepoContext): Promise<RegisterPage[]> {
	const modules = await collectModules(context)
	const groups = new Map<string, ModuleEntry[]>()

	for (const module of modules) {
		// The configuration files at the repository root share one group.
		const group = module.file.includes("/") ? censusGroupOf(module.file) : "root"

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
	// The register sorts the machines itself, so both runs write the same index.
	machines.sort((a, b) => a.machine.name.localeCompare(b.machine.name) || a.file.localeCompare(b.file))

	const pages = [
		indexPage(sorted, machines),
		...[...sorted].map(([group, entries]) => workspacePage(group, entries, listings.get(group)!)),
	]

	return formatPages(context.repoRoot, pages)
}

/**
 * The pages as the repository's formatter writes them, so `yarn lint`
 * and this register agree on every page's text.
 */
async function formatPages(repoRoot: string, pages: readonly RegisterPage[]): Promise<RegisterPage[]> {
	// effect-loads: oxfmt.config.ts
	const { default: config } = (await import(resolvePath(repoRoot, "oxfmt.config.ts").toString())) as {
		default: FormatConfig
	}

	return Promise.all(
		pages.map(async (page) => {
			const result = await format(page.path, page.mdx, config)

			if (result.errors.length) {
				throw new Error(
					`oxfmt could not format ${page.path}: ${result.errors.map((error) => error.message).join("; ")}`
				)
			}

			return { path: page.path, mdx: result.code }
		})
	)
}
