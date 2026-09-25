/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Loads a directory of JSON files into one {@link GeographicModelDocument}.
 *
 *   The file layout has no meaning. Any file may hold any subset of the tables, and only `model.json`
 *   may declare the document's `version`.
 *
 *   The loader sorts files by path before reading them, so directory enumeration order never affects
 *   the output. It records the source file of every record and maps each validation issue back to that
 *   file. A duplicate-identifier issue also reports the file that used the identifier first.
 *
 *   `./validate.ts` performs document validation. The loader checks only that each file parses, holds
 *   an object and uses known table keys.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { isPlainObject } from "@mailwoman/core/objects"
import { compareByCodePoint as compareIdentifiers } from "@mailwoman/core/strings/compare"
import { resolvePath } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import type { GeographicModelDocument } from "#schema"
import { validateGeographicModelDocument } from "#validate"
import {
	add,
	checkFieldNames,
	readArray,
	readString,
	type ValidationIssue,
	ValidationIssueCode,
} from "#validation/issues"
/**
 * The manifest file that every model directory contains.
 * It holds only the document's `version`.
 */
export const MODEL_MANIFEST_FILENAME = "model.json"

/**
 * The table keys that a non-manifest source file may use.
 */
const TABLE_FIELDS = ["relations", "concepts", "mappings", "observations", "derivedFacts"] as const

type TableField = (typeof TABLE_FIELDS)[number]

const MANIFEST_FIELDS = ["version"] as const

/**
 * Matches a record's path in the merged document, such as `$.concepts[7]` or `$.concepts[7].assertions[1]`.
 * Group 3 matches only for a nested assertion.
 */
const RECORD_PATH_PATTERN = /^\$\.([A-Za-z]+)\[(\d+)\](?:\.assertions\[(\d+)\])?/u

/**
 * Load issue codes: every validation code plus `MalformedJSON`.
 */
export const LoadIssueCode = {
	...ValidationIssueCode,
	/**
	 * A source file is not valid JSON.
	 */
	MalformedJSON: "malformed_json",
} as const

/**
 * A {@link LoadIssueCode} value.
 */
export type LoadIssueCode = (typeof LoadIssueCode)[keyof typeof LoadIssueCode]

/**
 * One load issue, attributed to its source file.
 */
export interface SourcedIssue {
	/**
	 * The source file path relative to the model directory, with `/` separators on every platform.
	 */
	file: string
	/**
	 * The JSONPath-style location in the merged document.
	 */
	path: string
	code: LoadIssueCode
	message: string
	/**
	 * For a duplicate identifier, the file that used the identifier first.
	 */
	otherFile?: string
}

/**
 * One source file's path, relative to the model directory, and its text.
 */
export interface GeographicModelSourceFile {
	path: string
	text: string
}

/**
 * Formats each issue as one `file:path: message [code]` line, in input order.
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
 * The error thrown when a model directory does not load.
 * Its message lists every issue.
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
 * The source of one record in the merged document.
 */
interface RecordOrigin {
	file: string
	/**
	 * The record's table, or `assertions` for an assertion nested in a concept.
	 * Identifiers are unique within a table.
	 */
	table: string
	id?: string
}

interface MergeState {
	issues: SourcedIssue[]
	tables: Record<TableField, unknown[]>
	origins: Map<string, RecordOrigin>
	/**
	 * Maps each table to its identifiers and the file that used each identifier first.
	 * The validator reports only the second use.
	 */
	firstClaims: Map<string, Map<string, string>>
	version?: string
}

function sourced(file: string, issues: readonly ValidationIssue[]): SourcedIssue[] {
	return issues.map((issue) => ({ file, path: issue.path, code: issue.code, message: issue.message }))
}

/**
 * Parses one source file, or records the parse failure and returns `undefined`.
 *
 * The loader calls `JSON.parse` directly because the report needs the parser's error message.
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
 * Appends one file's tables to the merged document and records each record's origin.
 */
function readTableFile(state: MergeState, file: GeographicModelSourceFile, value: unknown): void {
	const issues: ValidationIssue[] = []

	if (!isPlainObject(value)) {
		add(issues, "$", ValidationIssueCode.WrongType, "a geographic-model source file must be an object")

		state.issues.push(...sourced(file.path, issues))

		return
	}

	// The field check allows `version` so that the specific error below can say where it belongs.
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
 * Attributes one validation issue to the file that contains the record.
 */
function attribute(state: MergeState, issue: ValidationIssue): SourcedIssue {
	const match = RECORD_PATH_PATTERN.exec(issue.path)
	const nested = match?.[3]
	const key = match ? `${match[1]}[${match[2]}]${nested ? `.assertions[${nested}]` : ""}` : undefined
	const origin = key ? state.origins.get(key) : undefined

	// Only the manifest contributes fields outside the tables, so it owns document-level issues.
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
 * Merges source files into one document and validates it.
 *
 * The function sorts files by path first, so the input order never affects the result.
 *
 * @throws {GeographicModelLoadError} With every issue, each attributed to its source file.
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

	// Validation issues cannot be attributed reliably after a structural failure, so those failures stop here.
	if (state.issues.length) throw new GeographicModelLoadError(state.issues)

	const result = validateGeographicModelDocument({ version: state.version, ...state.tables })

	if (!result.ok) {
		throw new GeographicModelLoadError(result.issues.map((issue) => attribute(state, issue)))
	}

	return result.document
}

/**
 * Lists every `*.json` file under `root` as a relative path, sorted by code point at each level.
 *
 * Symbolic links are skipped because only regular files and directories match.
 */
async function listSourceFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await Globerator.from("*", {
		cwd: resolvePath(root, prefix),
		withFileTypes: true,
		onlyFiles: false,
	}).toArray()

	const found: string[] = []

	for (const entry of entries.toSorted((left, right) => compareIdentifiers(left.name, right.name))) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name

		if (entry.isDirectory()) {
			found.push(...(await listSourceFiles(root, path)))

			continue
		}

		if (entry.isFile() && entry.name.endsWith(".json")) {
			found.push(path)
		}
	}

	return found
}

/**
 * Reads every `*.json` file under `root`, merges the files and validates the merged document.
 *
 * @throws {GeographicModelLoadError} With every issue, each attributed to its source file.
 */
export async function loadGeographicModelDirectory(root: string): Promise<GeographicModelDocument> {
	const paths = await listSourceFiles(root)
	const files: GeographicModelSourceFile[] = []

	for (const path of paths) {
		files.push({ path, text: await readLocalTextFile(resolvePath(root, path)) })
	}

	return mergeGeographicModelFiles(files)
}
