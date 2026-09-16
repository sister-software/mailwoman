import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import {
	collectGitHubCommentNodes,
	CommentKind,
	syncCommentTriage,
	triageComment,
	type CommentTriageDatabase,
	type GitHubPageFetcher,
} from "@mailwoman/repo-health"
import { DatabaseClient } from "@mailwoman/sqlite/client"
import { join } from "path-ts"
import { describe, expect, it } from "vitest"

const firstIssuePage = new URL("https://api.github.com/repos/acme/widgets/issues/comments?per_page=100")
const secondIssuePage = new URL("https://api.github.com/repos/acme/widgets/issues/comments?page=2&per_page=100")

function comment(id: string, body: string) {
	return {
		node_id: id,
		body,
		html_url: `https://github.com/acme/widgets/comments/${id}`,
		user: { login: "reviewer" },
		created_at: "2026-09-16T10:00:00Z",
		updated_at: "2026-09-16T10:00:00Z",
	}
}

const pages: GitHubPageFetcher = async (url) => {
	if (url.href === firstIssuePage.href)
		return { body: [comment("IC_1", "Currently this is obviously broken!!")], next: secondIssuePage }

	if (url.href === secondIssuePage.href) return { body: [comment("IC_2", "Short follow-up.")], next: undefined }

	if (url.pathname.endsWith("/pulls/comments"))
		return { body: [comment("PRRC_1", "Please change this.")], next: undefined }

	if (url.pathname.endsWith("/discussions/comments"))
		return { body: [comment("DC_1", "A discussion reply.")], next: undefined }

	throw new Error(`Unexpected page ${url}`)
}

describe("collectGitHubCommentNodes", () => {
	it("follows each GitHub collection's pagination and preserves its kind", async () => {
		await expect(collectGitHubCommentNodes("acme", "widgets", pages)).resolves.toEqual([
			expect.objectContaining({ id: "IC_1", kind: CommentKind.Issue }),
			expect.objectContaining({ id: "IC_2", kind: CommentKind.Issue }),
			expect.objectContaining({ id: "PRRC_1", kind: CommentKind.Review }),
			expect.objectContaining({ id: "DC_1", kind: CommentKind.Discussion }),
		])
	})
})

describe("triageComment", () => {
	it("makes review leads without calling them decisions", () => {
		expect(triageComment("Currently this is obviously broken!! etc.").map((lead) => lead.label)).toEqual([
			"potentially_outdated",
			"sensational",
			"unclear",
		])
	})
})

describe("syncCommentTriage", () => {
	it("retains immutable snapshots and deduplicates rule findings across reruns", async () => {
		await using directory = await temporaryDirectory("comment-triage-")
		const database = join(directory.path, "triage.sqlite")
		const now = () => new Date("2026-09-16T12:00:00Z")

		const first = await syncCommentTriage({ owner: "acme", repository: "widgets", database, fetchPage: pages, now })
		const second = await syncCommentTriage({ owner: "acme", repository: "widgets", database, fetchPage: pages, now })

		expect(first).toMatchObject({ comments: 4, snapshots: 4, findings: 2 })
		expect(second).toMatchObject({ comments: 4, snapshots: 0, findings: 0 })

		using db = new DatabaseClient<CommentTriageDatabase>(database)
		expect(await db.selectFrom("comment_triage_run").selectAll().execute()).toHaveLength(2)
		expect(await db.selectFrom("comment_triage_node").selectAll().execute()).toHaveLength(4)
		expect(await db.selectFrom("comment_triage_snapshot").selectAll().execute()).toHaveLength(4)
		expect(await db.selectFrom("comment_triage_finding").selectAll().execute()).toHaveLength(2)
	})
})
