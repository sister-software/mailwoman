/**
 * GitHub comment triage is a local review cache, not a source of truth. The sync records exactly what GitHub returned;
 * labels are reproducible leads for a reviewer and never alter a comment.
 */

import { makeDirectories } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { dirname, type PathBuilderLike } from "path-ts"

/**
 * The three repository-wide GitHub REST comment collections this synchronizer imports.
 */
export const CommentKind = {
	Discussion: "discussion_comment",
	Issue: "issue_comment",
	Review: "pull_request_review_comment",
} as const

export type CommentKind = (typeof CommentKind)[keyof typeof CommentKind]

export interface GitHubCommentNode {
	id: string
	kind: CommentKind
	body: string
	url: string
	author: string | null
	createdAt: string
	updatedAt: string
}

export interface GitHubPageFetcher {
	(url: URL): Promise<{ body: unknown; next: URL | undefined }>
}

export interface CommentTriageDatabase {
	comment_triage_run: {
		id: string
		owner: string
		repository: string
		started_at: string
		completed_at: string | null
	}
	comment_triage_node: {
		github_node_id: string
		kind: CommentKind
		url: string
		author_login: string | null
		created_at: string
		updated_at: string
		last_seen_run_id: string
	}
	comment_triage_snapshot: {
		id: string
		github_node_id: string
		body_markdown: string
		content_sha256: string
		fetched_at: string
	}
	comment_triage_finding: {
		id: string
		snapshot_id: string
		label: string
		severity: "minor" | "material"
		confidence: "low" | "medium"
		rationale: string
		analyzer: string
		status: "proposed"
		created_at: string
	}
}

export interface SyncCommentTriageOptions {
	owner: string
	repository: string
	database: PathBuilderLike
	fetchPage: GitHubPageFetcher
	now?: () => Date
}

export interface SyncCommentTriageResult {
	runId: string
	comments: number
	snapshots: number
	findings: number
}

interface GitHubRestComment {
	node_id?: unknown
	body?: unknown
	html_url?: unknown
	user?: { login?: unknown } | null
	created_at?: unknown
	updated_at?: unknown
}

const SOURCES: ReadonlyArray<{ path: string; kind: CommentKind }> = [
	{ path: "issues/comments", kind: CommentKind.Issue },
	{ path: "pulls/comments", kind: CommentKind.Review },
	{ path: "discussions/comments", kind: CommentKind.Discussion },
]

/**
 * A length only earns review as potentially verbose once a reviewer might lose the requested action in it.
 */
const VERBOSE_COMMENT_WORDS = 150

function asComment(value: unknown, kind: CommentKind): GitHubCommentNode {
	if (!value || typeof value !== "object") throw new TypeError("GitHub returned a non-object comment record")

	const comment = value as GitHubRestComment
	const required = [comment.node_id, comment.body, comment.html_url, comment.created_at, comment.updated_at]

	if (required.some((field) => typeof field !== "string")) {
		throw new TypeError("GitHub returned a comment record missing a stable node field")
	}

	return {
		id: comment.node_id as string,
		kind,
		body: comment.body as string,
		url: comment.html_url as string,
		author: typeof comment.user?.login === "string" ? comment.user.login : null,
		createdAt: comment.created_at as string,
		updatedAt: comment.updated_at as string,
	}
}

/**
 * Fetch every REST page for the three repository-wide comment collections GitHub exposes.
 */
export async function collectGitHubCommentNodes(
	owner: string,
	repository: string,
	fetchPage: GitHubPageFetcher
): Promise<GitHubCommentNode[]> {
	const comments: GitHubCommentNode[] = []

	for (const source of SOURCES) {
		let page: URL | undefined = new URL(
			`https://api.github.com/repos/${owner}/${repository}/${source.path}?per_page=100`
		)

		while (page) {
			const response = await fetchPage(page)

			if (!Array.isArray(response.body)) throw new TypeError(`GitHub ${source.path} response was not an array`)

			comments.push(...response.body.map((comment) => asComment(comment, source.kind)))
			page = response.next
		}
	}

	return comments
}

export interface TriageLead {
	label: "potentially_outdated" | "sensational" | "unclear" | "overly_verbose"
	severity: "minor" | "material"
	confidence: "low" | "medium"
	rationale: string
}

/**
 * Conservative rule leads. A label is intentionally not a decision about the author or the comment.
 */
export function triageComment(body: string): TriageLead[] {
	const leads: TriageLead[] = []
	const words = body.trim().split(/\s+/).filter(Boolean)

	if (/\b(?:as of|currently|today|this year|last year|in \d{4})\b/i.test(body)) {
		leads.push({
			label: "potentially_outdated",
			severity: "minor",
			confidence: "low",
			rationale:
				"Contains a time-sensitive reference; compare it with the current repository state before relying on it.",
		})
	}

	if (/!{2,}|\b(?:disaster|catastrophic|insane|obviously|unbelievable)\b/i.test(body)) {
		leads.push({
			label: "sensational",
			severity: "minor",
			confidence: "medium",
			rationale: "Uses emphatic punctuation or an editorial intensifier; consider a factual replacement.",
		})
	}

	if (/\b(?:etc\.|somehow\b|something\b|stuff\b|things\b)/i.test(body)) {
		leads.push({
			label: "unclear",
			severity: "minor",
			confidence: "low",
			rationale: "Uses an unspecified referent; name the object, condition, or requested action if one is intended.",
		})
	}

	if (words.length > VERBOSE_COMMENT_WORDS) {
		leads.push({
			label: "overly_verbose",
			severity: "material",
			confidence: "low",
			rationale: `Contains ${words.length} words; review for a buried action, repetition, or digression before shortening.`,
		})
	}

	return leads
}

function createSchema(db: DatabaseClient<CommentTriageDatabase>): void {
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE IF NOT EXISTS comment_triage_run (
			id TEXT PRIMARY KEY, owner TEXT NOT NULL, repository TEXT NOT NULL,
			started_at TEXT NOT NULL, completed_at TEXT
		);
		CREATE TABLE IF NOT EXISTS comment_triage_node (
			github_node_id TEXT PRIMARY KEY, kind TEXT NOT NULL, url TEXT NOT NULL,
			author_login TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_seen_run_id TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS comment_triage_snapshot (
			id TEXT PRIMARY KEY, github_node_id TEXT NOT NULL REFERENCES comment_triage_node(github_node_id),
			body_markdown TEXT NOT NULL, content_sha256 TEXT NOT NULL, fetched_at TEXT NOT NULL,
			UNIQUE(github_node_id, content_sha256)
		);
		CREATE TABLE IF NOT EXISTS comment_triage_finding (
			id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES comment_triage_snapshot(id),
			label TEXT NOT NULL, severity TEXT NOT NULL, confidence TEXT NOT NULL, rationale TEXT NOT NULL,
			analyzer TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
			UNIQUE(snapshot_id, label, analyzer)
		);
	`)
}

/**
 * Persist a repeatable GitHub snapshot and rule findings. Existing snapshots and findings are retained, so a later sync
 * cannot erase the evidence an earlier review decision was based on.
 */
export async function syncCommentTriage(options: SyncCommentTriageOptions): Promise<SyncCommentTriageResult> {
	const now = options.now ?? (() => new Date())
	const startedAt = now().toISOString()
	const runId = crypto.randomUUID()
	const comments = await collectGitHubCommentNodes(options.owner, options.repository, options.fetchPage)

	await makeDirectories(dirname(options.database))
	using db = new DatabaseClient<CommentTriageDatabase>(options.database)
	createSchema(db)

	const insertRun = db.prepare(
		"INSERT INTO comment_triage_run (id, owner, repository, started_at, completed_at) VALUES (?, ?, ?, ?, NULL)"
	)

	const upsertNode = db.prepare(`
		INSERT INTO comment_triage_node (github_node_id, kind, url, author_login, created_at, updated_at, last_seen_run_id)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(github_node_id) DO UPDATE SET kind = excluded.kind, url = excluded.url,
			author_login = excluded.author_login, created_at = excluded.created_at, updated_at = excluded.updated_at,
			last_seen_run_id = excluded.last_seen_run_id
	`)

	const insertSnapshot = db.prepare(
		"INSERT OR IGNORE INTO comment_triage_snapshot (id, github_node_id, body_markdown, content_sha256, fetched_at) VALUES (?, ?, ?, ?, ?)"
	)

	const insertFinding = db.prepare(`
		INSERT OR IGNORE INTO comment_triage_finding
		(id, snapshot_id, label, severity, confidence, rationale, analyzer, status, created_at)
		VALUES (?, ?, ?, ?, ?, ?, 'rule/v1', 'proposed', ?)
	`)

	insertRun.run(runId, options.owner, options.repository, startedAt)
	let snapshots = 0
	let findings = 0

	for (const comment of comments) {
		upsertNode.run(comment.id, comment.kind, comment.url, comment.author, comment.createdAt, comment.updatedAt, runId)
		const contentHash = sha256Hex(comment.body)
		const snapshotId = sha256Hex(`${comment.id}\0${contentHash}`)
		const snapshot = insertSnapshot.run(snapshotId, comment.id, comment.body, contentHash, startedAt)
		snapshots += Number(snapshot.changes)

		for (const lead of triageComment(comment.body)) {
			const findingId = sha256Hex(`${snapshotId}\0${lead.label}\0rule/v1`)

			const finding = insertFinding.run(
				findingId,
				snapshotId,
				lead.label,
				lead.severity,
				lead.confidence,
				lead.rationale,
				startedAt
			)

			findings += Number(finding.changes)
		}
	}

	db.prepare("UPDATE comment_triage_run SET completed_at = ? WHERE id = ?").run(now().toISOString(), runId)

	return { runId, comments: comments.length, snapshots, findings }
}
