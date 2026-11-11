/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates the published CLI reference page from the compiled command specifications, so `yarn compile` must run first.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isFile } from "@mailwoman/core/fs/readers/stat"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import type { PathBuilder } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { readCommands, type CommandNode, type OptionSpec } from "./cli-schema.mts"

// #region Scope policy

/**
 * The command groups the page documents command by command, where the empty
 * string stands for the top-level commands.
 */
export const DOCUMENTED_GROUPS: readonly string[] = ["", "data", "skill", "clients", "registry"]

/**
 * One-line summaries for the groups outside {@link DOCUMENTED_GROUPS}, every one of which needs an entry.
 */
export const GROUP_NOTES: Readonly<Record<string, string>> = {
	corpus: "Builds and audits the BIO-labeled training corpus.",
	coverage: "Builds the demo map's address-coverage overlay tiles.",
	dev: "Repository maintenance: source generation, fixture capture, lint passes.",
	eval: "Runs the evaluations that decide whether a model ships.",
	filer: "Record-linkage evaluation over regulatory filings.",
	gazetteer: "Builds every gazetteer artifact, including the candidate and admin databases.",
	gnaf: "Assembles the Australian G-NAF address register.",
	placer: "Trains and evaluates the coarse country placer.",
	release: "Stages model weights for a release and admin-merges a pull request behind its guards.",
	situs: "Builds the US rooftop address-point and interpolation databases.",
	tiger: "Processes US Census TIGER/Line road and boundary data.",
	tiles: "Publishes vector tiles to the demo map's bucket.",
	train: "Resolves the training configurations the model trainer reads.",
	wof: "Prepares and inspects the Who's On First gazetteer source tree.",
}

// #endregion

// #region Derived shapes

/**
 * A row in a command's flag table.
 */
export interface CLIFlag {
	flag: string
	type: string
	/**
	 * The default as rendered for the table, `—` when the flag has none.
	 */
	default: string
	description: string
}

/**
 * A row in a command's positional-argument table.
 */
export interface CLIArgument {
	name: string
	required: boolean
	description: string
}

/**
 * A command as the reference page renders it.
 */
export interface CLICommand {
	path: string
	synopsis: string
	description: string
	args: CLIArgument[]
	flags: CLIFlag[]
}

/**
 * A documented command group and its commands.
 */
export interface CLIGroup {
	name: string
	commands: CLICommand[]
}

/**
 * A command group that the page summarizes in one row.
 */
export interface CLIGroupSummary {
	name: string
	commandCount: number
	note: string
}

/**
 * The collected command tree that the page renders.
 */
export interface CLISurface {
	documented: CLIGroup[]
	undocumented: CLIGroupSummary[]
	totalCommands: number
}

// #endregion

// #region Type + default rendering

function renderType(option: OptionSpec): string {
	if (option.choices) return option.choices.map((value) => `\`${value}\``).join(" \\| ")

	return `${option.type}${option.multiple ? "[]" : ""}`
}

function renderFlag(name: string, option: OptionSpec): string {
	if (option.type === "boolean") return option.default === true ? `--no-${name}` : `--${name}`
	const placeholder = `${name}${option.multiple ? "..." : ""}`

	return `--${name} ${option.required ? `<${placeholder}>` : `[${placeholder}]`}`
}

/**
 * Render a value for the `Default` column, with an absolute path as `environment-dependent`
 * so the page publishes no host paths.
 */
export function renderDefault(value: unknown): string {
	if (value === undefined) return "—"

	if (typeof value === "string") {
		if (value.startsWith("/")) return "environment-dependent"

		return value === "" ? '`""`' : `\`${value}\``
	}

	if (Array.isArray(value)) return `\`${stringifyJSON(value)}\``

	return `\`${String(value)}\``
}

// #endregion

// #region MDX escaping + tables

/**
 * Escape a help string for an MDX table cell, covering the characters MDX,
 * Markdown tables or `oxfmt` interpret.
 */
export function escapeCell(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("{", "&#123;")
		.replaceAll("}", "&#125;")
		.replaceAll("|", "\\|")
		.replaceAll("*", "\\*")
		.replaceAll("\n", " ")
		.trim()
}

/**
 * Render a Markdown table padded to the column widths that `oxfmt` produces.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length), 3)
	)

	const line = (cells: readonly string[]): string =>
		`| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`

	return [line(headers), `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map(line)].join("\n")
}

// #endregion

// #region Collection

function collectCommands(node: CommandNode, prefix: readonly string[], into: CLICommand[]): void {
	const path = [...prefix, node.name]

	if (node.component && node.spec) {
		const flags: CLIFlag[] = Object.entries(node.spec.options ?? {}).map(([name, option]) => ({
			flag: renderFlag(name, option),
			type: renderType(option),
			default: renderDefault(option.default),
			description: option.description,
		}))

		const args = node.spec.positionals ?? []

		const placeholders = args.map((argument) => {
			const name = `${argument.name}${argument.multiple ? "..." : ""}`

			return argument.required ? `<${name}>` : `[${name}]`
		})

		into.push({
			path: path.join(" "),
			synopsis: ["mailwoman", ...path, flags.length ? "[options]" : "", ...placeholders]
				.filter((word) => word.length)
				.join(" "),
			description: node.spec.description,
			args: args.map((argument, index) => ({
				name: placeholders[index]!,
				required: argument.required === true,
				description: argument.description,
			})),
			flags,
		})
	}

	if (node.commands) {
		for (const child of [...node.commands.values()].toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
			collectCommands(child, path, into)
		}
	}
}

// Paths resolve from the `mailwoman` package root, independent of the working directory.
const packagePath = resolvePackageDirectory("mailwoman")

/**
 * The directory of compiled command modules.
 */
export const COMMANDS_DIRECTORY = packagePath("out", "cli", "commands")
/**
 * The directory of compiled native commands.
 * The generator merges them into the command tree.
 */
export const NATIVE_COMMANDS_DIRECTORY = packagePath("out", "cli", "native", "commands")

/**
 * The compiled command modules under `compiled` whose source under `source` no longer exists.
 *
 * Incremental `tsc -b` leaves a moved or deleted command's output in `out/`,
 * so a stale tree renders commands the checkout no longer has.
 */
export async function compiledCommandsWithoutSource(compiled: PathBuilder, source: PathBuilder): Promise<string[]> {
	const modules = await Globerator.from("**/*.js", { cwd: compiled, absolute: false }).toArray()
	const orphans: string[] = []

	for (const module of modules.filter((entry) => !entry.endsWith(".d.js") && !entry.includes(".test."))) {
		const stem = module.replace(/\.js$/u, "")

		if (!(await isFile(source(`${stem}.ts`))) && !(await isFile(source(`${stem}.tsx`)))) {
			orphans.push(stem)
		}
	}

	return orphans.toSorted()
}

/**
 * Read the compiled commands and split them into documented and summarized groups.
 *
 * @throws When a compiled command has no source, naming each.
 * @throws When a group outside {@link DOCUMENTED_GROUPS} has no {@link GROUP_NOTES} entry.
 */
export async function collectCLISurface(): Promise<CLISurface> {
	const stale = [
		...(await compiledCommandsWithoutSource(COMMANDS_DIRECTORY, packagePath("cli", "commands"))),
		...(await compiledCommandsWithoutSource(NATIVE_COMMANDS_DIRECTORY, packagePath("cli", "native", "commands"))),
	]

	if (stale.length) {
		throw new Error(
			`out/ holds ${stale.length} compiled commands with no source (${stale.join(", ")}). Remove ` +
				"packages/mailwoman/out and run `yarn compile` before rendering the CLI reference."
		)
	}

	const commandsDirectory = COMMANDS_DIRECTORY
	const nativeCommands = await readCommands(NATIVE_COMMANDS_DIRECTORY)
	const tree = await readCommands(commandsDirectory, new Set(nativeCommands.keys()))

	for (const [name, command] of nativeCommands) {
		tree.set(name, command)
	}

	const documented: CLIGroup[] = []
	const undocumented: CLIGroupSummary[] = []
	let totalCommands = 0

	const rootCommands: CLICommand[] = []
	const groups = new Map<string, CommandNode>()

	for (const node of tree.values()) {
		if (node.component && !node.commands) {
			collectCommands(node, [], rootCommands)
		} else {
			groups.set(node.name, node)
		}
	}

	rootCommands.sort((a, b) => a.path.localeCompare(b.path, "en"))
	totalCommands += rootCommands.length

	const byName = new Map<string, CLICommand[]>()

	for (const [name, node] of groups) {
		const commands: CLICommand[] = []

		for (const child of [...(node.commands?.values() ?? [])].toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
			collectCommands(child, [name], commands)
		}

		if (node.component) {
			collectCommands({ ...node, commands: null }, [], commands)
		}

		commands.sort((a, b) => a.path.localeCompare(b.path, "en"))
		byName.set(name, commands)
		totalCommands += commands.length
	}

	for (const group of DOCUMENTED_GROUPS) {
		if (group === "") {
			documented.push({ name: "", commands: rootCommands })

			continue
		}

		const commands = byName.get(group)

		if (!commands) {
			throw new Error(
				`generate-cli-reference: DOCUMENTED_GROUPS names \`${group}\`, which no longer exists under ` +
					`${commandsDirectory}. Remove it or point it at the group that replaced it.`
			)
		}

		documented.push({ name: group, commands })
	}

	for (const name of [...byName.keys()].toSorted((a, b) => a.localeCompare(b, "en"))) {
		if (DOCUMENTED_GROUPS.includes(name)) continue

		const note = GROUP_NOTES[name]

		if (!note) {
			throw new Error(
				`generate-cli-reference: command group \`${name}\` has no GROUP_NOTES entry. Add one line saying what ` +
					`the group is for, or add it to DOCUMENTED_GROUPS so every one of its commands is published.`
			)
		}

		undocumented.push({ name, commandCount: byName.get(name)!.length, note })
	}

	return { documented, undocumented, totalCommands }
}

// #endregion

// #region Rendering

function replaceExactlyOnce(page: string, source: string, replacement: string): string {
	const first = page.indexOf(source)

	if (first === -1 || page.indexOf(source, first + source.length) >= 0) {
		throw new Error(`The generated CLI page must contain exactly one copy of: ${source.slice(0, 80)}`)
	}

	return `${page.slice(0, first)}${replacement}${page.slice(first + source.length)}`
}

const FRONTMATTER = [
	"---",
	"title: CLI",
	"description: Every command and flag the published Mailwoman CLI accepts, generated from command specifications.",
	"role: reference",
	"source-of-truth: generated — docs/scripts/generate-cli-reference.mts",
	"---",
	"",
	"{/* Generated by docs/scripts/generate-cli-reference.mts. Edit the command specifications. The generator overwrites this file. */}",
].join("\n")

function groupHeading(name: string): string {
	return name === "" ? "Top-level commands" : `\`mailwoman ${name}\``
}

function renderCommand(command: CLICommand): string {
	const parts: string[] = [`### \`mailwoman ${command.path}\``, ""]

	if (command.description) {
		parts.push(escapeCell(command.description), "")
	}

	parts.push("```", command.synopsis, "```", "")

	if (command.args.length) {
		parts.push(
			renderTable(
				["Argument", "Required", "Description"],
				command.args.map((argument) => [
					`\`${argument.name}\``,
					argument.required ? "Yes" : "No",
					argument.description ? escapeCell(argument.description) : "—",
				])
			),
			""
		)
	}

	if (command.flags.length) {
		parts.push(
			renderTable(
				["Flag", "Type", "Default", "Description"],
				command.flags.map((flag) => [
					`\`${flag.flag}\``,
					flag.type,
					flag.default,
					flag.description ? escapeCell(flag.description) : "—",
				])
			),
			""
		)
	} else if (!command.args.length) {
		parts.push("This command takes no arguments and no flags.", "")
	}

	return parts.join("\n")
}

/**
 * Render the reference page.
 * The same surface always yields the same text.
 */
export function renderCLIReference(surface: CLISurface): string {
	// oxlint-disable-next-line unicorn/no-array-reduce -- Total is fine here.
	const documentedCount = surface.documented.reduce((total, group) => total + group.commands.length, 0)

	const sections: string[] = [
		FRONTMATTER,
		"",
		"# CLI",
		"",
		"## Scope",
		"",
		"This page is the flag interface for the `mailwoman` command-line interface. Each table is generated from",
		"the command's own schema, and each description is that flag's help text verbatim, so this page and",
		"`mailwoman <command> --help` cannot disagree.",
		"",
		`The CLI has ${surface.totalCommands} commands. This page documents the ${documentedCount} that a consumer of the published`,
		"package runs. The rest build the datasets and train the models inside a checkout of the repository,",
		"and they are listed by group under [Commands this page does not cover](#commands-this-page-does-not-cover).",
		"",
		"Three conventions apply to every table below.",
		"",
		"- A flag written `--no-<name>` is on by default. Pass it to turn the behavior off.",
		"- A default shown as `environment-dependent` resolves from the environment at run time. The flag's",
		"  description states which variable it reads.",
		"- A value in angle brackets in a synopsis is required. A value in square brackets is optional.",
		"",
		"This page lists each command's synopsis and flags. For executed invocations with their real output, follow the",
		"tutorials and how-to guides linked under [See also](#see-also).",
		"",
	]

	for (const group of surface.documented) {
		sections.push(`## ${groupHeading(group.name)}`, "")

		for (const command of group.commands) {
			sections.push(renderCommand(command))
		}
	}

	sections.push(
		"## Exit codes",
		"",
		"Every command shares one exit-code interface, owned by `useCommandTask` in `packages/mailwoman/cli/kit`.",
		"",
		renderTable(
			["Code", "Meaning", "Next step"],
			[
				["`0`", "The command completed. A command with a verdict returns `0` for a pass.", "None."],
				[
					"`1`",
					"The command threw, or its verdict is a failure. The message is on `stderr`.",
					"Read the message. Guidance-grade failures print one line and name the fix.",
				],
			]
		),
		"",
		"Two behaviors are exceptional because they are not failures.",
		"",
		"- `mailwoman doctor` exits `0` when the core checks pass, even when every optional data layer is",
		"  missing. The parser runs without the optional data layers.",
		"- `mailwoman parse` degrades to the structural stages when the neural weights are absent, prints a",
		"  warning on `stderr`, and still exits `0`. Standard output stays machine-parseable.",
		"",
		"## Commands this page does not cover",
		"",
		"These groups build the data and the models. They read paths and databases that only exist inside a",
		"checkout of the repository, and they are documented in the repository rather than here. The two build",
		"tutorials under [See also](#see-also) run the ones a self-hosting reader needs.",
		"",
		renderTable(
			["Group", "Commands", "Purpose"],
			surface.undocumented.map((group) => [
				`\`mailwoman ${group.name}\``,
				String(group.commandCount),
				escapeCell(group.note),
			])
		),
		"",
		"## Rationale",
		"",
		"This page is generated rather than written because a hand-maintained flag table is wrong the day a",
		"flag changes, and no check catches it. The generator reads the same command specifications that",
		"build the binary, so a flag string here is the flag string `--help` prints. A test asserts the",
		"committed page against a fresh render. A stale page therefore fails the build.",
		"",
		`The scope split is deliberate. A page that covers all ${surface.totalCommands} commands would bury the ${documentedCount} that run against`,
		"an installed package under training and dataset tooling that requires the repository, its data root,",
		"and hours of wall clock. The generator refuses to run if it meets a command group it has never been",
		"told about, so the boundary is a decision someone makes rather than an omission.",
		"",
		"## See also",
		"",
		"- [Library API](./library-api.mdx) — the same pipeline, called from TypeScript.",
		"- [HTTP APIs](./http-apis.mdx) — the server surfaces, including `mailwoman serve`.",
		"- [Runtime flags](./runtime-flags.mdx) — the environment variables these commands read.",
		"- [Understand a parse](../tutorials/understand-a-parse.mdx) — `mailwoman parse`, executed.",
		"- [Geocode a CSV](../tutorials/geocode-a-csv.mdx) — `mailwoman data pull` and `mailwoman geocode`, executed.",
		"- [Build the US dataset](../tutorials/build-the-us-dataset.mdx) — the `gazetteer` and `situs` groups, executed.",
		""
	)

	return `${sections.join("\n").replaceAll(/\n{3,}/g, "\n\n")}`
}

/**
 * Render the new CLI route with release-specific checks beside the generated current-checkout interface.
 */
export function renderRebuildCLIReference(surface: CLISurface): string {
	const oldPage = renderCLIReference(surface)
	const documentedCount = surface.documented.reduce((total, group) => total + group.commands.length, 0)
	const groupedCount = surface.totalCommands - documentedCount

	const releaseChecks = [
		"## Published 11.0.0 checks",
		"",
		"The command tables below come from the current checkout's compiled command specifications. They can change after a release. The following syntax and exit statuses were checked with published `mailwoman@11.0.0` on Node.js 24.22.1 on 9 November 2026. Run `mailwoman <command> --help` in your installed version to check its complete flag set.",
		"",
		renderTable(
			["Published command", "Observed 11.0.0 result", "Exit status"],
			[
				["`mailwoman --version`", "Printed `11.0.0`.", "`0`"],
				[
					"`mailwoman parse --help`",
					"Printed `Usage: mw parse <address...> [options]`. The `--locale` default was `en-US`.",
					"`0`",
				],
				[
					"`mailwoman data status candidate --data-root /tmp/mailwoman-r06-empty`",
					"Reported `wof/candidate.db: missing (expected ~2.9 GB)` for an empty disposable data root.",
					"`1`",
				],
				[
					"`mailwoman doctor --verbose`",
					"Reported `PASS — core checks ok (runtime + weights); parse is ready` while the optional admin gazetteer was missing.",
					"`0`",
				],
				[
					"`mailwoman serve --help`",
					"Printed `Usage: mw serve [options]` with `--port`, `--host`, and `--cpus`.",
					"`0`",
				],
			]
		),
		"",
		"The `data status` result describes the empty test directory. The published `serve` help command was executed, while starting a data-backed server and geocoding an address were not run for this page. [Data and locales](/docs/reference/data-and-locales) lists the bundle prerequisites. [Packages and runtime](/docs/reference/packages-and-runtime) lists the Node requirement and database settings.",
		"",
	].join("\n")

	const oldScope = [
		"This page is the flag interface for the `mailwoman` command-line interface. Each table is generated from",
		"the command's own schema, and each description is that flag's help text verbatim, so this page and",
		"`mailwoman <command> --help` cannot disagree.",
	].join("\n")

	const newScope = [
		"This page lists the current checkout's `mailwoman` command tree. The command tables are generated",
		"from compiled command specifications. Published 11.0.0 behavior is recorded separately above",
		"because checkout commands can change after release.",
	].join("\n")

	const oldExit = [
		"Every command shares one exit-code interface, owned by `useCommandTask` in `packages/mailwoman/cli/kit`.",
	].join("\n")

	const newExit =
		"The current checkout defines these command completion statuses. Check the published examples above for observed 11.0.0 behavior."

	const oldExitTable = renderTable(
		["Code", "Meaning", "Next step"],
		[
			["`0`", "The command completed. A command with a verdict returns `0` for a pass.", "None."],
			[
				"`1`",
				"The command threw, or its verdict is a failure. The message is on `stderr`.",
				"Read the message. Guidance-grade failures print one line and name the fix.",
			],
		]
	)

	const newExitTable = renderTable(
		["Code", "Meaning", "Next step"],
		[
			["`0`", "The command completed. A command with a verdict returns `0` for a pass.", "None."],
			[
				"`1`",
				"The command failed or returned a failing verdict. Check stdout and stderr for details.",
				"Read the message. Guidance-grade failures print one line and name the fix.",
			],
		]
	)

	const oldSummary = `The CLI has ${surface.totalCommands} commands. This page documents the ${documentedCount} that a consumer of the published\npackage runs. The rest build the datasets and train the models inside a checkout of the repository,\nand they are listed by group under [Commands this page does not cover](#commands-this-page-does-not-cover).`
	const newSummary = `The current checkout's generated tree contains ${surface.totalCommands} commands. This page gives full flags for ${documentedCount} of those ${surface.totalCommands} commands. The remaining ${groupedCount} commands appear by group under [Commands this page does not cover](#commands-this-page-does-not-cover). Some documented commands require repository inputs.`
	const oldRationale = `This page is generated rather than written because a hand-maintained flag table is wrong the day a\nflag changes, and no check catches it. The generator reads the same command specifications that\nbuild the binary, so a flag string here is the flag string \`--help\` prints. A test asserts the\ncommitted page against a fresh render. A stale page therefore fails the build.\n\nThe scope split is deliberate. A page that covers all ${surface.totalCommands} commands would bury the ${documentedCount} that run against\nan installed package under training and dataset tooling that requires the repository, its data root,\nand hours of wall clock. The generator refuses to run if it meets a command group it has never been\ntold about, so the boundary is a decision someone makes rather than an omission.`
	const newRationale = `The build regenerates this page from the current checkout's compiled command specifications. The exact-generation test compares the page with a fresh render. The published 11.0.0 checks above were run separately against an installed package. The generated tables describe the checkout and may differ from that release.`

	const replacements = [
		["title: CLI", "title: CLI command reference"],
		[
			"description: Every command and flag the published Mailwoman CLI accepts, generated from command specifications.",
			"description: Current-checkout CLI commands and flags, with selected published 11.0.0 checks.",
		],
		[
			"source-of-truth: generated — docs/scripts/generate-cli-reference.mts",
			"source-of-truth: generated — docs/scripts/generate-cli-reference.mts\nverified-with: current compiled command specs and selected mailwoman v11.0.0 commands",
		],
		[oldScope, newScope],
		[oldSummary, newSummary],
		["## Top-level commands", `${releaseChecks}\n## Top-level commands`],
		[oldExit, newExit],
		[oldExitTable, newExitTable],
		[
			"These groups build the data and the models. They read paths and databases that only exist inside a\ncheckout of the repository, and they are documented in the repository rather than here. The two build\ntutorials under [See also](#see-also) run the ones a self-hosting reader needs.",
			"These groups build data and models using repository tooling and inputs. Their flags are summarized by group here. Read the repository's engineering documentation before using them.",
		],
		[oldRationale, newRationale],
		[
			"- [Library API](./library-api.mdx) — the same pipeline, called from TypeScript.\n- [HTTP APIs](./http-apis.mdx) — the server surfaces, including `mailwoman serve`.\n- [Runtime flags](./runtime-flags.mdx) — the environment variables these commands read.\n- [Understand a parse](../tutorials/understand-a-parse.mdx) — `mailwoman parse`, executed.\n- [Geocode a CSV](../tutorials/geocode-a-csv.mdx) — `mailwoman data pull` and `mailwoman geocode`, executed.\n- [Build the US dataset](../tutorials/build-the-us-dataset.mdx) — the `gazetteer` and `situs` groups, executed.",
			"- [Library API](./library.mdx) — callable TypeScript interfaces.\n- [HTTP interfaces](./http.mdx) — native and compatibility routes with versioned OpenAPI documents.\n- [Packages and runtime](./packages-and-runtime.mdx) — Node requirements and environment settings.\n- [Data and locales](./data-and-locales.mdx) — bundle dependencies and locale mechanisms.\n- [Inspect a parse](../tutorials/inspect-a-parse.mdx) — an executed parse trace.",
		],
	] as const

	let page: string = oldPage

	for (const [source, replacement] of replacements) {
		page = replaceExactlyOnce(page, source, replacement)
	}

	return page
}

// #endregion

/**
 * The path of the generated page.
 */
export const OUTPUT_PATH = repoRootPath("docs", "articles", "reference", "cli.mdx")

/**
 * Collect the command surface and render the page without writing it.
 */
export async function generateCLIReference(): Promise<string> {
	const surface = await collectCLISurface()

	return renderRebuildCLIReference(surface)
}

if (import.meta.main) {
	const surface = await collectCLISurface()

	const rendered = renderRebuildCLIReference(surface)
	const existing = await readLocalTextFile(OUTPUT_PATH).catch(() => null)

	if (existing !== rendered) {
		await writeLocalFile(rendered, OUTPUT_PATH)
	}

	console.log(
		existing === rendered ? "docs/articles/reference/cli.mdx is current" : "Wrote docs/articles/reference/cli.mdx"
	)
}
