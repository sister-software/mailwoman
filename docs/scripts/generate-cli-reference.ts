/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Generates `docs/articles/developers/reference/cli.mdx` — the published CLI contract — from the
 *   command specifications themselves, so the page cannot drift from the binary. Runs in the docs
 *   `prebuild` beside the four OpenAPI emits (`docs/package.json`), and the committed page is
 *   asserted byte-for-byte by `generate-cli-reference.test.ts`.
 *
 *   HOW THE SURFACE IS DERIVED. `mailwoman/commands/**` is walked as a directory tree, with each executable module
 *   exporting the same native `CommandSpec` used by runtime parsing and help.
 *
 *   The walk reads the COMPILED tree (`mailwoman/out/commands`), not source: the commands are TSX,
 *   which Node cannot type-strip. `docs` already depends on that tree — every OpenAPI emit in
 *   `prebuild` shells `mailwoman/out/cli.js` — so this adds no new prerequisite. Run `yarn compile`
 *   first.
 *
 *   SCOPE. The CLI carries 125 commands across 25 groups; most are the repo's own data-build,
 *   training and evaluation tooling, which only runs inside a checkout. {@link DOCUMENTED_GROUPS}
 *   names the groups a consumer of the published package runs, and every command in those groups is
 *   emitted — a new sibling appears on the page with no edit here. The remaining groups are listed
 *   by name with a count and a one-line purpose from {@link GROUP_NOTES}; a group absent from that
 *   map is a hard error, so a new group can never vanish from the page silently.
 *
 *   DETERMINISM. Same tree in, same bytes out: no timestamps, no version stamps, no host paths (an
 *   absolute-path default renders as `environment-dependent` — `geocode --data-root` otherwise bakes
 *   this machine's data root into a published page), groups in declared order, commands sorted.
 *   Table cells are padded the way `oxfmt` pads them, so the emitted file is already formatted.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { resolvePackageDirectory } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { join } from "path-ts"

import { readCommands, type CommandNode, type OptionSpec } from "./cli-schema.ts"

//#region Scope policy

/**
 * The command groups this page documents in full. `""` is the root of `commands/`, i.e. the commands invoked as
 * `mailwoman <name>` with no group. Every command found in these groups is emitted, so adding a sibling command needs
 * no edit here.
 */
export const DOCUMENTED_GROUPS: readonly string[] = ["", "data", "skill", "clients", "registry"]

/**
 * One line per top-level group the page does NOT document, stating what the group is for. Every group discovered
 * outside {@link DOCUMENTED_GROUPS} must appear here — {@link collectCLISurface} throws otherwise, so a new group is
 * impossible to add without deciding whether a consumer needs it.
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
	release: "Stages model weights for a release.",
	situs: "Builds the US rooftop address-point and interpolation databases.",
	tiger: "Processes US Census TIGER/Line road and boundary data.",
	tiles: "Publishes vector tiles to the demo map's bucket.",
	wof: "Prepares and inspects the Who's On First gazetteer source tree.",
}

//#endregion

//#region Derived shapes

/**
 * One flag row.
 */
export interface CLIFlag {
	/**
	 * The rendered flag, e.g. `--format [format]` or `--no-admin-coherence`.
	 */
	flag: string
	/**
	 * The value the flag accepts: `boolean`, `string`, `number`, `string[]`, or the enum's members.
	 */
	type: string
	/**
	 * The default, already rendered for the table. `—` when the flag has none.
	 */
	default: string
	/**
	 * The flag's own help text from its command specification.
	 */
	description: string
}

/**
 * One positional-argument row.
 */
export interface CLIArgument {
	name: string
	required: boolean
	description: string
}

/**
 * One command.
 */
export interface CLICommand {
	/**
	 * The invocation without the binary, e.g. `data pull`.
	 */
	path: string
	/**
	 * The synopsis line, e.g. `mailwoman data pull [options] <bundles...>`.
	 */
	synopsis: string
	/**
	 * The command's `export const description`, when it declares one.
	 */
	description?: string
	args: CLIArgument[]
	flags: CLIFlag[]
}

/**
 * One documented group and its commands.
 */
export interface CLIGroup {
	/**
	 * The group name, or `""` for the root commands.
	 */
	name: string
	commands: CLICommand[]
}

/**
 * A group the page names but does not document.
 */
export interface CLIGroupSummary {
	name: string
	commandCount: number
	note: string
}

/**
 * Everything the page renders from.
 */
export interface CLISurface {
	documented: CLIGroup[]
	undocumented: CLIGroupSummary[]
	/**
	 * Every command the walk found, documented or not — the denominator the page states.
	 */
	totalCommands: number
}

//#endregion

//#region Type + default rendering

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
 * The `Default` column. Absolute paths are suppressed: `geocode --data-root` defaults to the resolved data root, so
 * printing the value would bake the generating machine's filesystem into a published page. Each such flag's description
 * already states which variable it reads.
 */
export function renderDefault(value: unknown): string {
	if (value === undefined) return "—"

	if (typeof value === "string") {
		if (value.startsWith("/")) return "environment-dependent"

		return value === "" ? '`""`' : `\`${value}\``
	}

	if (Array.isArray(value)) return `\`${JSON.stringify(value)}\``

	return `\`${String(value)}\``
}

//#endregion

//#region MDX escaping + tables

/**
 * Make a source-authored help string safe as MDX table-cell text. Docusaurus compiles `.mdx` through micromark's JSX
 * extension, so a bare `<address>` is an element and a bare `{ checks: [...] }` is an expression — both build-breaking
 * or content-eating (the class `mailwoman dev lint mdx-angles` gates). Entities render as the literal characters and
 * cannot be parsed as syntax. The pipe escape is the table's own requirement, and the asterisk escape is `oxfmt`'s: a
 * literal `*` in prose (`place_bbox R*Tree`) is emphasis syntax, and leaving it raw makes the emitted file fail
 * `--check`.
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
 * Render a GitHub-flavored table with cells padded to the widest in their column — the shape `oxfmt` normalizes
 * markdown tables to, so the emitted file passes `oxfmt --check` without a reformat pass.
 */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, column) =>
		Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length), 3)
	)

	const line = (cells: readonly string[]): string =>
		`| ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`

	return [line(headers), `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`, ...rows.map(line)].join("\n")
}

//#endregion

//#region Collection

/**
 * Walk one command node into flat {@link CLICommand} records, deepest path first.
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
				.filter((word) => word.length > 0)
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

// The PACKAGE ROOT, not the directory of the package's entry file. `dirname(resolveModulePath("mailwoman"))`
// answered the same thing only while the entry sat at the package root; once source moved under `lib/` it started
// answering `mailwoman/lib`, and the `out/` joins below silently became `mailwoman/lib/out/…`.
const packagePath = resolvePackageDirectory("mailwoman")

/**
 * The compiled command tree this generator reads, resolved from this file rather than a working directory so the script
 * behaves the same from the repo root and from `docs/`.
 */
export const COMMANDS_DIRECTORY = join(packagePath, "out", "commands")
/**
 * Compiled direct-command directory merged with the filesystem command tree.
 */
export const NATIVE_COMMANDS_DIRECTORY = join(packagePath, "out", "cli-native", "commands")

/**
 * Read the compiled command tree and partition it by {@link DOCUMENTED_GROUPS}.
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

	// Root commands first.
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

		// A group whose own index.tsx is a command (`corpus extract`) contributes it too.
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

//#endregion

//#region Rendering

const FRONTMATTER = [
	"---",
	"title: CLI",
	"description: Every command and flag the published Mailwoman CLI accepts, generated from command specifications.",
	"role: reference",
	"source-of-truth: generated — docs/scripts/generate-cli-reference.ts",
	"---",
	"",
	"{/* Generated by docs/scripts/generate-cli-reference.ts. Edit command specifications, not this file. */}",
].join("\n")

/**
 * The heading a group's section carries.
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
 * Render the whole page. Pure — the same {@link CLISurface} always produces the same bytes.
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
		"This page is the flag contract for the `mailwoman` command-line interface. Each table is generated from",
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
		"Commands are shown here, not run. For executed invocations with their real output, follow the",
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
		"Every command shares one exit-code contract, owned by `useCommandTask` in `packages/mailwoman/lib/cli-kit`.",
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
		"flag changes, and nothing catches it. The generator reads the same command specifications that",
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

//#endregion

/**
 * The page this generator owns.
 */
export const OUTPUT_PATH = repoRootPath("docs", "articles", "developers", "reference", "cli.mdx")

/**
 * Render the page and write it. Returns the rendered text so a caller can compare rather than write.
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
