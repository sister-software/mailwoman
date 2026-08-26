/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The authoring loader: a directory of JSON files in, one {@link GeographicModelDocument} out.
 *
 *   **The filesystem layout is authoring convenience and carries no meaning.** A concept means the
 *   same thing whichever file it was written in, and a file may hold any subset of the tables. What a
 *   directory does carry is one manifest — `model.json`, holding the document's `version` — because a
 *   version assembled from whichever fragment happened to declare one is a version nobody chose.
 *
 *   Two properties make the loader safe to build an artifact from:
 *
 *   1. **Enumeration order cannot reach the output.** {@link mergeGeographicModelFiles} sorts the
 *      files it was handed before reading any of them, so the merged tables are a function of the file
 *      NAMES and their contents. `readdir` order, and therefore the filesystem, is out of the answer.
 *   2. **Every issue names the file it came from.** The document validator addresses a record by its
 *      position in the merged table (`$.concepts[7].kind`), which is the one thing an author cannot
 *      see; the loader keeps a per-record origin and re-addresses each issue to its source file. A
 *      duplicate identifier names both files — the one that claimed it and the one that claimed it
 *      first — because "already used" is unactionable without the other half.
 *
 *   Validation itself is delegated whole to `./validate.ts`. What the loader checks on its own is only
 *   what the validator cannot see: whether a file parses, whether it is an object, and whether the
 *   keys it uses are tables.
 */

import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { compareIdentifiers } from "./artifact.ts"
import type { GeographicModelDocument } from "./schema.ts"
import { validateGeographicModelDocument } from "./validate.ts"
import {
	add,
	checkFieldNames,
	isPlainObject,
	readArray,
	readString,
	type ValidationIssue,
	ValidationIssueCode,
} from "./validation-issues.ts"

/**
 * The manifest every model directory carries: the document's `version`, and nothing else.
 */
export const MODEL_MANIFEST_FILENAME = "model.json"

/**
 * The keys a source file may use. They are the document's tables, minus the manifest's `version`.
 */
const TABLE_FIELDS = ["relations", "concepts", "mappings", "observations", "derivedFacts"] as const

type TableField = (typeof TABLE_FIELDS)[number]

const MANIFEST_FIELDS = ["version"] as const

/**
 * The document path a record occupies, e.g. `$.concepts[7]` or `$.concepts[7].assertions[1]`. Group 3 is present only
 * for an assertion, which is the one record that nests.
 */
const RECORD_PATH_PATTERN = /^\$\.([A-Za-z]+)\[(\d+)\](?:\.assertions\[(\d+)\])?/u

/**
 * Every way loading can fail. The document validator's whole vocabulary, plus the one failure only a loader meets: a
 * file that is not JSON at all.
 */
export const LoadIssueCode = {
	...ValidationIssueCode,
	/**
	 * A source file could not be parsed as JSON. Emitted by the loader alone; the document validator is handed values,
	 * never text.
	 */
	MalformedJSON: "malformed_json",
} as const

export type LoadIssueCode = (typeof LoadIssueCode)[keyof typeof LoadIssueCode]

/**
 * One violation, addressed to the file an author can open.
 */
export interface SourcedIssue {
	/**
	 * The source file, relative to the model directory, with `/` separators on every platform.
	 */
	file: string
	/**
	 * The JSONPath-style address into the MERGED document, kept so a reader can find the record in the table the
	 * validator saw.
	 */
	path: string
	code: LoadIssueCode
	message: string
	/**
	 * For a duplicate identifier: the file that claimed it first.
	 */
	otherFile?: string
}

/**
 * One authoring file: its path relative to the model directory, and its text.
 */
export interface GeographicModelSourceFile {
	path: string
	text: string
}

/**
 * Render every issue as one line, `file:path: message [code]`, in the order the loader produced them.
 */
export function formatSourcedIssues(issues: readonly SourcedIssue[]): string {
	return issues
		.map((issue) => {
			const claimant = issue.otherFile ? ` — first claimed in ${issue.otherFile}` : ""

			return `${issue.file}:${issue.path}: ${issue.message}${claimant} [${issue.code}]`
		})
		.join("\n")
}

/**
 * Thrown when a model directory does not load. Carries every issue, and states them all in its message, so a caller
 * that only prints `error.message` still sees the whole list.
 */
export class GeographicModelLoadError extends Error {
	readonly issues: readonly SourcedIssue[]

	constructor(issues: readonly SourcedIssue[]) {
		super(`geographic-model source does not load (${issues.length} issues)\n${formatSourcedIssues(issues)}`)

		this.name = "GeographicModelLoadError"
		this.issues = issues
	}
}

/**
 * Where one record came from, kept so a validation issue addressed to the merged table can be re-addressed to a file.
 */
interface RecordOrigin {
	file: string
	/**
	 * The table the record was appended to, or `assertions` for one nested inside a concept — the namespace its
	 * identifier is unique within.
	 */
	table: string
	id?: string
}

interface MergeState {
	issues: SourcedIssue[]
	tables: Record<TableField, unknown[]>
	origins: Map<string, RecordOrigin>
	/**
	 * Table → identifier → the file that used it first. The validator reports the SECOND claimant, so this is what names
	 * the other half of the pair.
	 */
	firstClaims: Map<string, Map<string, string>>
	version?: string
}

function sourced(file: string, issues: readonly ValidationIssue[]): SourcedIssue[] {
	return issues.map((issue) => ({ file, path: issue.path, code: issue.code, message: issue.message }))
}

/**
 * Parse one source file, or report why it could not be parsed.
 *
 * The house wrapper lives in `@mailwoman/core/objects`, and this package takes no dependency on `@mailwoman/core` — the
 * boundary record keeps world semantics out of core, and a build-time loader is not the reason to reverse it. The
 * parser's own message is also the useful half of the report here, which a wrapper returning a fallback discards.
 */
function readSourceJSON(file: GeographicModelSourceFile, issues: SourcedIssue[]): unknown {
	try {
		// oxlint-disable-next-line no-restricted-properties -- see the note above.
		return JSON.parse(file.text)
	} catch (error) {
		issues.push({
			file: file.path,
			path: "$",
			code: LoadIssueCode.MalformedJSON,
			message: error instanceof Error ? error.message : String(error),
		})

		return undefined
	}
}

function claim(state: MergeState, table: string, id: string | undefined, file: string): void {
	if (id === undefined) return

	const claims = state.firstClaims.get(table) ?? new Map<string, string>()

	state.firstClaims.set(table, claims)

	if (!claims.has(id)) {
		claims.set(id, file)
	}
}

function recordID(entry: unknown): string | undefined {
	if (!isPlainObject(entry)) return undefined

	return typeof entry.id === "string" ? entry.id : undefined
}

function readManifestFile(state: MergeState, file: GeographicModelSourceFile, value: unknown): void {
	const issues: ValidationIssue[] = []

	if (!isPlainObject(value)) {
		add(issues, "$", ValidationIssueCode.WrongType, `\`${MODEL_MANIFEST_FILENAME}\` must be an object`)
	} else {
		checkFieldNames(issues, "$", value, MANIFEST_FIELDS)

		state.version = readString(issues, "$", value, "version", true)
	}

	state.issues.push(...sourced(file.path, issues))
}

/**
 * Append one file's tables to the merged document, recording where every record came from.
 */
function readTableFile(state: MergeState, file: GeographicModelSourceFile, value: unknown): void {
	const issues: ValidationIssue[] = []

	if (!isPlainObject(value)) {
		add(issues, "$", ValidationIssueCode.WrongType, "a geographic-model source file must be an object")

		state.issues.push(...sourced(file.path, issues))

		return
	}

	// `version` is admitted to the field check and then refused on its own, so the report names where a version belongs
	// instead of only saying the field is unknown here.
	checkFieldNames(issues, "$", value, [...TABLE_FIELDS, ...MANIFEST_FIELDS])

	if ("version" in value) {
		add(
			issues,
			"$.version",
			ValidationIssueCode.UnknownField,
			`the document's \`version\` is authored in \`${MODEL_MANIFEST_FILENAME}\`, not in a table file`
		)
	}

	for (const table of TABLE_FIELDS) {
		if (!(table in value)) continue

		for (const entry of readArray(issues, "$", value, table, false) ?? []) {
			const index = state.tables[table].length
			const id = recordID(entry)
			const documentPath = `${table}[${index}]`

			state.tables[table].push(entry)
			state.origins.set(documentPath, { file: file.path, table, id })
			claim(state, table, id, file.path)

			if (table !== "concepts" || !isPlainObject(entry) || !Array.isArray(entry.assertions)) continue

			for (const [position, assertion] of entry.assertions.entries()) {
				const assertionID = recordID(assertion)

				state.origins.set(`${documentPath}.assertions[${position}]`, {
					file: file.path,
					table: "assertions",
					id: assertionID,
				})

				claim(state, "assertions", assertionID, file.path)
			}
		}
	}

	state.issues.push(...sourced(file.path, issues))
}

/**
 * Re-address one validation issue from its position in the merged document to the file the record was authored in.
 */
function attribute(state: MergeState, issue: ValidationIssue): SourcedIssue {
	const match = RECORD_PATH_PATTERN.exec(issue.path)
	const nested = match?.[3]
	const key = match ? `${match[1]}[${match[2]}]${nested ? `.assertions[${nested}]` : ""}` : undefined
	const origin = key ? state.origins.get(key) : undefined

	// A document-level issue — `$.version`, or the root itself — is about the manifest, which is the only file that
	// contributes anything outside a table.
	const file = origin?.file ?? MODEL_MANIFEST_FILENAME

	const claimant =
		issue.code === ValidationIssueCode.DuplicateID && origin?.id
			? state.firstClaims.get(origin.table)?.get(origin.id)
			: undefined

	return {
		file,
		path: issue.path,
		code: issue.code,
		message: issue.message,
		...(claimant ? { otherFile: claimant } : {}),
	}
}

/**
 * Merge authoring files into one document, and validate the result.
 *
 * The files are sorted by path before anything is read, so any enumeration order produces the same tables in the same
 * order. Throws {@link GeographicModelLoadError} with every issue, each addressed to its source file; returns nothing
 * partial.
 */
export function mergeGeographicModelFiles(files: readonly GeographicModelSourceFile[]): GeographicModelDocument {
	const state: MergeState = {
		issues: [],
		tables: { relations: [], concepts: [], mappings: [], observations: [], derivedFacts: [] },
		origins: new Map(),
		firstClaims: new Map(),
	}

	const ordered = files.toSorted((left, right) => compareIdentifiers(left.path, right.path))
	const manifest = ordered.find((file) => file.path === MODEL_MANIFEST_FILENAME)

	if (!manifest) {
		state.issues.push({
			file: MODEL_MANIFEST_FILENAME,
			path: "$",
			code: LoadIssueCode.MissingField,
			message: `a model directory carries \`${MODEL_MANIFEST_FILENAME}\`, holding the document's \`version\``,
		})
	}

	for (const file of ordered) {
		const value = readSourceJSON(file, state.issues)

		if (value === undefined) continue

		if (file === manifest) {
			readManifestFile(state, file, value)

			continue
		}

		readTableFile(state, file, value)
	}

	// A record issue cannot be addressed to a file that failed to parse, so the structural pass reports alone.
	if (state.issues.length) throw new GeographicModelLoadError(state.issues)

	const result = validateGeographicModelDocument({ version: state.version, ...state.tables })

	if (!result.ok) {
		throw new GeographicModelLoadError(result.issues.map((issue) => attribute(state, issue)))
	}

	return result.document
}

/**
 * Every `*.json` file under `root`, relative to it, in code-point order.
 *
 * Directory entries are sorted at each level rather than taken as `readdir` returns them, so the list is a property of
 * the tree and not of the filesystem that stored it. Symbolic links are not followed: a model directory is source, and
 * a link out of it is a record whose home nobody can state.
 */
function listSourceFiles(root: string, prefix = ""): string[] {
	const entries = readdirSync(resolve(root, prefix), { withFileTypes: true })
	const found: string[] = []

	for (const entry of entries.toSorted((left, right) => compareIdentifiers(left.name, right.name))) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			found.push(...listSourceFiles(root, path))

			continue
		}

		if (entry.isFile() && entry.name.endsWith(".json")) {
			found.push(path)
		}
	}

	return found
}

/**
 * Load a model directory: read every `*.json` file under it, merge them, and validate the result.
 *
 * Throws {@link GeographicModelLoadError} with every issue, each addressed to its source file.
 */
export function loadGeographicModelDirectory(root: string): GeographicModelDocument {
	const files = listSourceFiles(root).map((path) => ({ path, text: readFileSync(resolve(root, path), "utf8") }))

	return mergeGeographicModelFiles(files)
}
