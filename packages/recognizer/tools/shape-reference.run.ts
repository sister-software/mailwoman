// SPDX-FileCopyrightText: Teffen Ellis and Mailwoman contributors
// SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Commercial

/**
 *   Writes the reference documentation of every recognition shape: one index page,
 *   `docs/engineering/reference/recognizer-shapes.mdx`, and one page for each family
 *   under `docs/engineering/reference/recognizer-shapes/`.
 *
 *   A shape's section lists its ID, scope, grammar in a readable form, captures,
 *   validator, payload fields, rejection codes, declared overlaps with their witnesses,
 *   and the source line of its declaration.
 *
 *   The pages are written from the committed intermediate representation (`data/ir/<family>.json`),
 *   the declarations (`data/declarations/<family>.json`) and the overlap witnesses (`data/fixtures/`).
 *   The five families `@mailwoman/recognizer` owns read those files from this package.
 *
 *   The two families `@mailwoman/postcode` owns, `postal` and `postcode_legacy`,
 *   are documented by this same tool.
 *   It reads their IR and witnesses from that package.
 *
 *   They declare no validator, so their sections hold no payload or rejection codes.
 *   `@mailwoman/postcode` generates its own files, and this tool only reads them.
 *
 *   An overlap is a pair of shapes that accept a common string.
 *   Each pair is declared on one side, and the section of both shapes lists it.
 *
 *   Usage: `node packages/recognizer/tools/shape-reference.run.ts [--check]`
 *
 *   `--check` leaves the pages as they are and exits non-zero when a committed page differs.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { writeLocalFile } from "@mailwoman/core/fs/writers"
import { repoRootPath, workspacePath } from "@mailwoman/core/paths"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { parseJSONStrict, stringifyJSON } from "@mailwoman/core/values/json"
import { type FormatConfig, format } from "oxfmt"

const { values } = parseArguments({ options: { check: { type: "boolean", default: false } } })

/**
 * A grammar node of the intermediate representation.
 */
interface GrammarNode {
	readonly op: string
	readonly value?: string
	readonly ranges?: ReadonlyArray<readonly [string, string]>
	readonly negated?: boolean
	readonly items?: readonly GrammarNode[]
	readonly alternatives?: readonly GrammarNode[]
	readonly node?: GrammarNode
	readonly min?: number
	readonly max?: number | null
	readonly path?: string
	readonly id?: string
	readonly regex?: string
}

interface IRShape {
	readonly id: string
	readonly grammar: GrammarNode
	readonly captures: ReadonlyArray<{ readonly path: string; readonly type: string }>
	readonly scope: string
	readonly validator: string | null
	readonly ambiguity: { readonly policy: string; readonly with?: readonly string[] }
	readonly unreachable?: string
	readonly partition?: string
	readonly role?: string
	readonly order?: number
	readonly boundary?: string
	readonly source: { readonly file: string; readonly line: number }
}

interface IRDocument {
	readonly family: string
	readonly hash: string
	readonly shapes: readonly IRShape[]
}

interface ShapeDeclaration {
	readonly id: string
	readonly kind: string
	readonly payload: ReadonlyArray<{ readonly name: string; readonly type: string; readonly optional: boolean }>
	readonly rejections: readonly string[]
}

interface WitnessFile {
	readonly pairs: ReadonlyArray<{
		readonly a: { readonly family: string; readonly shape: string }
		readonly b: { readonly family: string; readonly shape: string }
		readonly witness: string
	}>
}

/**
 * The families, with the package that owns each one and the witness files that name its shapes.
 */
const FAMILIES = [
	{ id: "coordinates", owner: "recognizer" },
	{ id: "identifiers", owner: "recognizer" },
	{ id: "primitives", owner: "recognizer" },
	{ id: "spatial", owner: "recognizer" },
	{ id: "structure", owner: "recognizer" },
	{ id: "postal", owner: "postcode" },
	{ id: "postcode_legacy", owner: "postcode" },
] as const

const WITNESS_FILES = [
	workspacePath("recognizer", "data", "fixtures", "overlap-witnesses.json"),
	workspacePath("postcode", "data", "fixtures", "postal-overlap-witnesses.json"),
]

/**
 * The longest grammar text a section prints before it stops and points at the IR.
 */
const GRAMMAR_LIMIT = 900

const DESCRIPTIONS: Record<string, string> = {
	coordinates: "WGS84 points in the spellings a search field receives, with a validator for each pair.",
	identifiers: "Names that stand in for a place: H3 cells, geohashes, Who's On First ids, Census GEOIDs and GNIS ids.",
	primitives: "Four small grammars for numbers, white space and words, which the other families overlap.",
	spatial: "Grid codes and documents that stand for a place: Plus Codes, DIGIPIN and GeoJSON.",
	structure: "The token, class, script and segment partitions that fill the structural fields of a result.",
	postal: "The postcode syntax of every country, grouped into shapes that share a language.",
	postcode_legacy: "The thirteen hand-written postcode patterns that fill the known formats of a result.",
}

function escapeCharacter(character: string): string {
	const point = character.codePointAt(0)!

	if (point < 0x20 || point > 0x7e) return `\\u{${point.toString(16)}}`

	return character === "\\" || character === "]" || character === "^" || character === "-"
		? `\\${character}`
		: character
}

function renderClass(node: GrammarNode): string {
	const ranges = (node.ranges ?? []).map(([from, to]) =>
		from === to ? escapeCharacter(from) : `${escapeCharacter(from)}-${escapeCharacter(to)}`
	)

	return `[${node.negated ? "^" : ""}${ranges.join("")}]`
}

/**
 * Whether a node needs parentheses when an operator applies to it.
 */
function isCompound(node: GrammarNode): boolean {
	return node.op === "sequence" || node.op === "choice"
}

function wrap(node: GrammarNode): string {
	const text = render(node)

	return isCompound(node) ? `(${text})` : text
}

/**
 * A grammar in a readable form: a regular-expression-like text with the terms of the family in braces.
 */
function render(node: GrammarNode): string {
	switch (node.op) {
		case "literal":
			return stringifyJSON(node.value)
		case "class":
			return renderClass(node)
		case "sequence":
			return (node.items ?? []).map((item) => (item.op === "choice" ? `(${render(item)})` : render(item))).join(" ")
		case "choice":
			return (node.alternatives ?? []).map(render).join(" | ")
		case "optional":
			return `${wrap(node.node!)}?`
		case "repeat": {
			const { min = 0, max } = node

			if (max === null || max === undefined)
				return `${wrap(node.node!)}${min === 0 ? "*" : min === 1 ? "+" : `{${min},}`}`

			return `${wrap(node.node!)}{${min === max ? min : `${min},${max}`}}`
		}
		case "capture":
			return `(?<${node.path}> ${render(node.node!)})`
		case "reference":
			return `{${node.id}}`
		case "pattern":
			return `/${node.regex}/`
		default:
			throw new Error(`the IR holds an operator this tool does not render: ${node.op}`)
	}
}

function cell(text: string): string {
	return text.replaceAll("|", "\\|")
}

function code(text: string): string {
	const shown = stringifyJSON(text).slice(1, -1)

	return `\`${cell(shown)}\``
}

async function readJSON<T>(path: string): Promise<T> {
	return parseJSONStrict<T>(await readLocalTextFile(path))
}

const witnessPairs: WitnessFile["pairs"][number][] = []

for (const file of WITNESS_FILES) {
	witnessPairs.push(...(await readJSON<WitnessFile>(file.toString())).pairs)
}

const SCOPES: Record<string, string> = {
	whole: "Whole input only",
	embedded: "Embedded only",
	whole_or_embedded: "Whole input or embedded",
	partition: "A piece of a partition",
}

function overlapsOf(family: string, shape: IRShape): string[] {
	const rows: string[] = []

	for (const pair of witnessPairs) {
		const [self, other] =
			pair.a.family === family && pair.a.shape === shape.id
				? [pair.a, pair.b]
				: pair.b.family === family && pair.b.shape === shape.id
					? [pair.b, pair.a]
					: [null, null]

		if (self && other) {
			rows.push(`| \`${other.family}\` | \`${other.shape}\` | ${code(pair.witness)} |`)
		}
	}

	return rows.toSorted()
}

function section(family: string, shape: IRShape, declaration: ShapeDeclaration | undefined): string {
	const out: string[] = []
	const grammar = render(shape.grammar)
	const shown = grammar.length > GRAMMAR_LIMIT ? `${grammar.slice(0, GRAMMAR_LIMIT)} ...` : grammar

	out.push(`## \`${shape.id}\``, "")
	out.push("| Field | Value |", "| --- | --- |")
	out.push(`| Scope | ${SCOPES[shape.scope] ?? shape.scope} |`)

	if (shape.boundary) {
		out.push(
			shape.boundary === "alnum"
				? `| Boundary | A letter or a digit can't touch an embedded match (\`${shape.boundary}\`) |`
				: `| Boundary | A letter, a digit or a connector can't touch an embedded match (\`${shape.boundary}\`) |`
		)
	}

	if (shape.partition) {
		out.push(`| Partition | \`${shape.partition}\` |`)
	}

	if (shape.role) {
		out.push(`| Role | \`${shape.role}\` |`)
	}

	if (shape.order !== undefined) {
		out.push(`| Order | ${shape.order} |`)
	}

	if (declaration) {
		out.push(`| Kind | \`${declaration.kind}\` |`)
	}

	out.push(`| Validator | ${shape.validator ? `\`${shape.validator}\`` : "None, a shape-only recognition"} |`)

	out.push(`| Declared at | \`${shape.source.file}:${shape.source.line}\` |`)

	if (shape.unreachable) {
		out.push(`| Declared unreachable | ${cell(shape.unreachable)} |`)
	}

	out.push("", "Grammar:", "", "```text", shown, "```", "")

	if (grammar.length > GRAMMAR_LIMIT) {
		out.push(`The grammar is ${grammar.length} characters in this form, and the IR holds it whole.`, "")
	}

	if (shape.captures.length) {
		out.push("Captures: " + shape.captures.map(({ path, type }) => `\`${path}\` (${type})`).join(", "), "")
	} else {
		out.push("The shape declares no captures.", "")
	}

	if (declaration?.payload.length) {
		out.push("Payload fields:", "")
		out.push("| Field | Type | Present |", "| --- | --- | --- |")

		for (const field of declaration.payload) {
			out.push(`| \`${field.name}\` | ${field.type} | ${field.optional ? "Sometimes" : "Always"} |`)
		}

		out.push("")
	}

	if (declaration?.rejections.length) {
		out.push("Rejection codes: " + declaration.rejections.map((rejection) => `\`${rejection}\``).join(", "), "")
	}

	const overlaps = overlapsOf(family, shape)

	if (overlaps.length) {
		out.push(`Overlaps declared (${overlaps.length}). Each witness is the shortest string that both shapes accept.`, "")

		out.push("| Family | Shape | Witness |", "| --- | --- | --- |", ...overlaps, "")
	} else {
		out.push("No other shape accepts a string this shape accepts.", "")
	}

	return out.join("\n")
}

/**
 * The front matter and header comment every generated page starts with.
 */
function pageHeader(title: string, description: string): string {
	return [
		"---",
		`title: "${title}"`,
		`description: "${description}"`,
		"role: reference",
		"audience: maintainer",
		"owner: engineering",
		"---",
		"",
		"{/* Generated by `node packages/recognizer/tools/shape-reference.run.ts`. Edit the grammars or the generator. */}",
		"",
	].join("\n")
}

const pages = new Map<string, string>()
const summary: string[] = []

for (const { id, owner } of FAMILIES) {
	const document = await readJSON<IRDocument>(workspacePath(owner, "data", "ir", `${id}.json`).toString())
	const declarations = new Map<string, ShapeDeclaration>()

	if (owner === "recognizer") {
		const file = await readJSON<{ shapes: ShapeDeclaration[] }>(
			workspacePath("recognizer", "data", "declarations", `${id}.json`).toString()
		)

		for (const declaration of file.shapes) {
			declarations.set(declaration.id, declaration)
		}
	}

	const shapes = document.shapes.toSorted((a, b) => a.id.localeCompare(b.id))
	const description = DESCRIPTIONS[id]!

	const lines = [
		pageHeader(
			`Recognition shapes: ${id}`,
			`Each shape of the ${id} family: its scope, grammar, captures, validator, rejection codes and declared overlaps.`
		),
		`# Recognition shapes: \`${id}\``,
		"",
		description,
		"",
		`The family has ${shapes.length} shapes. Its IR hash is \`${document.hash}\`. It is built from \`${owner === "recognizer" ? "packages/recognizer" : "packages/postcode"}/data/ir/${id}.json\`. [The index](../recognizer-shapes.mdx) explains each field.`,
		"",
	]

	for (const shape of shapes) {
		lines.push(section(id, shape, declarations.get(shape.id)))
	}

	pages.set(`recognizer-shapes/${id}.mdx`, lines.join("\n"))
	summary.push(`| [\`${id}\`](./recognizer-shapes/${id}.mdx) | \`${owner}\` | ${shapes.length} | ${description} |`)
}

pages.set(
	"recognizer-shapes.mdx",
	[
		pageHeader(
			"Recognition shapes",
			"Every shape the recognition engine reads, one page for each family, written from the compiled intermediate representation."
		),
		"# Recognition shapes",
		"",
		"A shape is a named formal language that the recognition engine reports as a span of the input. Each family page lists its shapes.",
		"Regenerate the pages with `node packages/recognizer/tools/shape-reference.run.ts`. Its `--check` flag compares the committed pages with the generator's output.",
		"",
		"## Fields of a shape",
		"",
		"- Scope: whether the shape matches the whole input, a span inside it, or either.",
		"- Boundary: the neighbors an embedded match may have. The `token` boundary refuses a match that sits inside a longer run of letters, digits and connectors, and the `alnum` boundary refuses one that touches a letter or a digit.",
		"- Kind: the closed name the generated TypeScript gives the shape.",
		"- Validator: the code that reads the captures of an accepted span and builds its typed payload or a typed rejection. A shape with no validator is a shape-only recognition.",
		"- Grammar: the language in a readable form. A term in braces is a named term of the family, `?` marks an optional part, and `(?<name> ...)` is a capture.",
		"- Payload fields and rejection codes: what a validated recognition carries and every code a rejected one can return, including the engine's own `capture_limit` and `capture_mismatch`.",
		"- Overlaps: pairs of shapes that accept a common string. A build refuses an undeclared overlap, and each declaration records the shortest shared string as its witness.",
		"",
		"A recognition is a claim about a span and not a confirmation. A shape of digits, such as a postcode or a Census GEOID, is a candidate until the data that owns the code confirms it.",
		"",
		"## Families",
		"",
		"The families `postal` and `postcode_legacy` belong to `@mailwoman/postcode`, which generates their IR and witnesses. This tool documents them from those files.",
		"",
		"| Family | Package | Shapes | Reads |",
		"| --- | --- | --- | --- |",
		...summary,
		"",
	].join("\n")
)

// effect-loads: oxfmt.config.ts
const { default: formatConfig } = (await import(repoRootPath("oxfmt.config.ts").toString())) as {
	default: FormatConfig
}

let stale = 0

for (const [name, text] of pages) {
	const target = repoRootPath("docs", "engineering", "reference", name).toString()
	const formatted = await format(target, text, formatConfig)

	if (formatted.errors.length) {
		throw new Error(`oxfmt could not format ${target}: ${formatted.errors.map((error) => error.message).join("; ")}`)
	}

	if (values.check) {
		const committed = await readLocalTextFile(target).catch(() => null)

		if (committed !== formatted.code) {
			console.error(`${target} differs from the generator's output`)

			stale++
		}
	} else {
		await writeLocalFile(formatted.code, target)

		console.log(`wrote ${target}`)
	}
}

if (stale) {
	process.exitCode = 1
}
