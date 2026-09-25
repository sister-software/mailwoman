/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates the published CLI reference page from the compiled command specifications.
 *
 *   The command modules are TSX, so run `yarn compile` first. A test compares the output with the committed page.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { stringifyJSON } from "@mailwoman/core/json"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"

import { readCommands, type CommandNode, type OptionSpec } from "./cli-schema.ts"

// #region Scope policy

/**
 * The command groups that the page documents command by command.
 *
 * The empty string stands for the top-level commands.
 */
export const DOCUMENTED_GROUPS: readonly string[] = ["", "data", "skill", "clients", "registry"]

/**
 * One-line summaries for the groups outside {@link DOCUMENTED_GROUPS}.
 * Every such group needs an entry.
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
	wof: "Prepares and inspects the Who's On First gazetteer source tree.",
}

// #endregion

// #region Derived shapes

/**
 * A row in a command's flag table.
 */
export interface CLIFlag {
	/**
	 * The rendered flag, such as `--format [format]` or `--no-admin-coherence`.
	 */
	flag: string
	/**
	 * The accepted value type, or the enum members when the flag has choices.
	 */
	type: string
	/**
	 * The default as rendered for the table.
	 * It is `—` when the flag has no default.
	 */
	default: string
	/**
	 * The help text from the command specification.
	 */
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
	/**
	 * The invocation without the binary name, such as `data pull`.
	 */
	path: string
	/**
	 * The synopsis line, such as `mailwoman data pull [options] <bundles...>`.
	 */
	synopsis: string
	/**
	 * The description from the command specification, if it has one.
	 */
	description?: string
	args: CLIArgument[]
	flags: CLIFlag[]
}

/**
 * A documented command group and its commands.
 */
export interface CLIGroup {
	/**
	 * The group name, or `""` for the top-level commands.
	 */
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
	/**
	 * The number of commands in every group, documented or summarized.
	 */
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
 * Render a value for the `Default` column.
 *
 * An absolute path renders as `environment-dependent` so the page does not publish host paths.
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
 * Escape a help string for use in an MDX table cell.
 *
 * The escaped characters are those that MDX, Markdown tables or `oxfmt` would interpret.
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

/**
 * Append a {@link CLICommand} for this node and each of its descendants that is a command.
 */
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

// Paths resolve from the `mailwoman` package root, which is independent of the working directory.
const packagePath = resolvePackageDirectory("mailwoman")

/**
 * The directory of compiled command modules.
 */
export const COMMANDS_DIRECTORY = packagePath("out", "commands")
/**
 * The directory of compiled native commands, which are merged into the command tree.
 */
export const NATIVE_COMMANDS_DIRECTORY = packagePath("out", "cli", "native", "commands")

/**
 * Read the compiled commands and split them into documented and summarized groups.
 *
 * @throws When a group outside {@link DOCUMENTED_GROUPS} has no {@link GROUP_NOTES} entry.
 */
export async function collectCLISurface(commandsDirectory = COMMANDS_DIRECTORY): Promise<CLISurface> {
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

		// A group that is also a command gets its own entry.
		if (node.component) {
			collectCommands({ ...node, commands: undefined }, [], commands)
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

const FRONTMATTER = [
	"---",
	"title: CLI",
	"description: Every command and flag the published Mailwoman CLI accepts, generated from command specifications.",
	"role: reference",
	"source-of-truth: generated — docs/scripts/generate-cli-reference.ts",
	"---",
	"",
	"{/* Generated by docs/scripts/generate-cli-reference.ts. Edit the command specifications; this file is overwritten. */}",
].join("\n")

/**
 * Return the heading for a command group.
 */
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
 * The same surface always produces the same text.
 */
export function renderCLIReference(surface: CLISurface): string {
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
		`The CLI carries ${surface.totalCommands} commands. This page documents the ${documentedCount} that a consumer of the published`,
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
		"Every command shares one exit-code interface, owned by `useCommandTask` in `packages/mailwoman/lib/cli/kit`.",
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
		"  missing. Parsing works without them.",
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
		"committed page against a fresh render, which turns a stale page into a failing build.",
		"",
		`The scope split is deliberate. Publishing all ${surface.totalCommands} commands would bury the ${documentedCount} that run against`,
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

// #endregion

/**
 * The path of the generated page.
 */
export const OUTPUT_PATH = repoRootPath("docs", "articles", "developers", "reference", "cli.mdx")

/**
 * Collect the command surface and render the page without writing it.
 *
 * @returns The rendered page text.
 */
export async function generateCLIReference(): Promise<string> {
	const surface = await collectCLISurface()

	return renderCLIReference(surface)
}

if (import.meta.main) {
	const rendered = await generateCLIReference()
	const existing = await readLocalTextFile(OUTPUT_PATH).catch(() => null)

	if (existing !== rendered) {
		await writeLocalFile(rendered, OUTPUT_PATH)
	}

	console.log(
		existing === rendered
			? "docs/articles/developers/reference/cli.mdx is current"
			: "Wrote docs/articles/developers/reference/cli.mdx"
	)
}
