/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file A deterministic inventory of TypeScript source comments and conservative editorial review leads.
 */

import { readLocalTextFile } from "@mailwoman/core/fs/readers"
import { sha256Hex } from "@mailwoman/core/hash"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { relative, resolvePath } from "path-ts"
import ts from "typescript"

export type CommentKind = "line" | "block" | "jsdoc"

export type TriageCategory = "outdated" | "sensational" | "unclear" | "overly_verbose"

export interface SourceComment {
	id: string
	path: string
	start: number
	end: number
	startLine: number
	startColumn: number
	endLine: number
	endColumn: number
	kind: CommentKind
	text: string
	contentHash: string
}

export interface TriageLead {
	commentID: string
	category: TriageCategory
	reason: string
	confidence: "low" | "medium" | "high"
	source: "heuristic" | "reviewer"
}

export interface InventoryResult {
	comments: number
	leads: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source_comment (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  end_column INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('line', 'block', 'jsdoc')),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_comment_path_range ON source_comment(path, start_offset, end_offset);
CREATE TABLE IF NOT EXISTS comment_triage_lead (
  comment_id TEXT NOT NULL REFERENCES source_comment(id),
  category TEXT NOT NULL CHECK (category IN ('outdated', 'sensational', 'unclear', 'overly_verbose')),
  reason TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  source TEXT NOT NULL CHECK (source IN ('heuristic', 'reviewer')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, category, reason, source)
);
`

interface CommentTriageDatabase {
	source_comment: { id: string }
	comment_triage_lead: { comment_id: string }
}

const SHORT_COMMENT_MAXIMUM_LENGTH = 120
const LONG_COMMENT_MINIMUM_LENGTH = 900
const LONG_COMMENT_MINIMUM_SENTENCES = 8

/**
 * How many sentences a comment's prose carries, splitting on terminal punctuation.
 *
 * The split leaves an empty segment wherever two terminators meet and one at the end when the prose closes on a
 * terminator, so only segments carrying a non-space character count.
 */
function countSentences(prose: string): number {
	return prose.split(/[.!?](?:\s|$)/).filter((segment) => segment.trim().length > 0).length
}

function digest(value: string): string {
	return sha256Hex(value)
}

function sourceFileFor(path: string, text: string): ts.SourceFile {
	return ts.createSourceFile(
		path,
		text,
		ts.ScriptTarget.Latest,
		false,
		path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	)
}

/**
 * Read every scanner-recognized line, block, and JSDoc comment with source coordinates.
 */
export function sourceComments(path: string, text: string): SourceComment[] {
	const source = sourceFileFor(path, text)
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, text)
	const comments: SourceComment[] = []

	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue

		const start = scanner.getTokenPos()
		const end = scanner.getTextPos()
		const commentText = text.slice(start, end)
		const startPosition = source.getLineAndCharacterOfPosition(start)
		const endPosition = source.getLineAndCharacterOfPosition(end)

		const kind: CommentKind =
			token === ts.SyntaxKind.SingleLineCommentTrivia ? "line" : commentText.startsWith("/**") ? "jsdoc" : "block"

		const contentHash = digest(commentText)

		comments.push({
			id: digest(`${path}:${start}:${end}:${contentHash}`),
			path,
			start,
			end,
			startLine: startPosition.line + 1,
			startColumn: startPosition.character + 1,
			endLine: endPosition.line + 1,
			endColumn: endPosition.character + 1,
			kind,
			text: commentText,
			contentHash,
		})
	}

	return comments
}

/**
 * Heuristics are leads only: each points at wording a human reviewer must confirm.
 */
export function heuristicLeads(comment: SourceComment): TriageLead[] {
	const prose = comment.text
		.replaceAll(/^\/\*+|\*\/|^\/\/+/gm, "")
		.replaceAll(/\s+/g, " ")
		.trim()

	const leads: TriageLead[] = []

	if (/\b(?:todo|fixme|xxx|hack)\b/i.test(prose)) {
		leads.push({
			commentID: comment.id,
			category: "outdated",
			reason: "Contains a maintenance marker; verify the stated work is still pending.",
			confidence: "low",
			source: "heuristic",
		})
	}

	if (/\b(?:obviously|clearly|simply|trivial(?:ly)?|insane|magic|never|always)\b/i.test(prose)) {
		leads.push({
			commentID: comment.id,
			category: "sensational",
			reason: "Contains absolute, emotive, or dismissive wording; verify it is warranted.",
			confidence: "low",
			source: "heuristic",
		})
	}

	if (/\b(?:this|that|it|they)\b/i.test(prose) && prose.length < SHORT_COMMENT_MAXIMUM_LENGTH) {
		leads.push({
			commentID: comment.id,
			category: "unclear",
			reason: "Short comment uses a deictic reference; verify the referent is unmistakable in local context.",
			confidence: "low",
			source: "heuristic",
		})
	}

	if (prose.length > LONG_COMMENT_MINIMUM_LENGTH || countSentences(prose) > LONG_COMMENT_MINIMUM_SENTENCES) {
		leads.push({
			commentID: comment.id,
			category: "overly_verbose",
			reason: "Long explanatory comment; verify it cannot be shortened or moved into documentation.",
			confidence: "low",
			source: "heuristic",
		})
	}

	return leads
}

export async function inventorySourceComments(
	databasePath: string,
	repoRoot: string,
	files: readonly string[]
): Promise<InventoryResult> {
	const observedAt = new Date().toISOString()
	using database = new DatabaseClient<CommentTriageDatabase>(databasePath)
	database.exec(SCHEMA)
	const insertComment = database.prepare(`INSERT INTO source_comment VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	const insertLead = database.prepare(`INSERT INTO comment_triage_lead VALUES (?, ?, ?, ?, ?, ?)`)
	let commentCount = 0
	let leadCount = 0

	database.exec("BEGIN IMMEDIATE; DELETE FROM comment_triage_lead; DELETE FROM source_comment;")

	try {
		for (const file of files) {
			const absolutePath = resolvePath(repoRoot, file)
			const comments = sourceComments(String(relative(repoRoot, absolutePath)), await readLocalTextFile(absolutePath))

			for (const comment of comments) {
				insertComment.run(
					comment.id,
					comment.path,
					comment.start,
					comment.end,
					comment.startLine,
					comment.startColumn,
					comment.endLine,
					comment.endColumn,
					comment.kind,
					comment.text,
					comment.contentHash,
					observedAt
				)

				commentCount++

				for (const lead of heuristicLeads(comment)) {
					insertLead.run(lead.commentID, lead.category, lead.reason, lead.confidence, lead.source, observedAt)

					leadCount++
				}
			}
		}

		database.exec("COMMIT;")
	} catch (error) {
		database.exec("ROLLBACK;")
		throw error
	}

	return { comments: commentCount, leads: leadCount }
}

/**
 * Persist human reviewer findings after validating their comment identity and taxonomy.
 */
export function recordReviewerLeads(databasePath: string, leads: readonly TriageLead[]): number {
	const observedAt = new Date().toISOString()
	using database = new DatabaseClient<CommentTriageDatabase>(databasePath)
	database.exec(SCHEMA)
	const knownComment = database.prepare("SELECT 1 FROM source_comment WHERE id = ?")
	const insert = database.prepare("INSERT OR IGNORE INTO comment_triage_lead VALUES (?, ?, ?, ?, ?, ?)")
	let inserted = 0

	for (const lead of leads) {
		if (!knownComment.get(lead.commentID)) throw new Error(`Unknown source comment: ${lead.commentID}`)

		inserted += Number(
			insert.run(lead.commentID, lead.category, lead.reason, lead.confidence, "reviewer", observedAt).changes
		)
	}

	return inserted
}
