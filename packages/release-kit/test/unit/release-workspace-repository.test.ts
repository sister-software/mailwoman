import { readLocalJSONFile } from "@mailwoman/core/fs/readers"
import { repoRootPath } from "@mailwoman/core/paths"
import { releaseWorkspaces } from "@mailwoman/release-kit/release/stage"
import { resolvePath } from "path-ts"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   #757 — fail-fast guard for the npm-provenance `repository` requirement.
 *
 *   Since the repo went public (v4.8.0) every npm publish is provenance-signed, and sigstore
 *   provenance verification REJECTS (HTTP 422) any workspace whose `package.json` lacks a
 *   `repository.url` matching the source repo. This is invisible until release, and has bitten
 *   twice on new/edited workspaces — `spatial` (#660, v4.10.0) and `tiger` (#739, v4.12.0) — each
 *   costing a recovery cycle. (Writing this test immediately caught a third + fourth: the two
 *   `neural-weights-*` workspaces had a `.git`-less url and no `directory`.)
 *
 *   This asserts EVERY workspace in the `.release-it.json` publish set carries the canonical
 *   `repository` block, so a drift fails at PR/CI time instead of mid-release.
 */
import { describe, expect, it } from "vitest"

const repoRoot = repoRootPath()
const CANONICAL_URL = "https://github.com/sister-software/mailwoman.git"

const workspaces = await releaseWorkspaces(repoRoot)

describe("#757 release provenance: every published workspace declares its repository", () => {
	it.each(workspaces)("%s/package.json has the canonical repository block", async (ws) => {
		const pkg = await readLocalJSONFile<{
			repository?: { type?: string; url?: string; directory?: string }
		}>(resolvePath(repoRoot, ws, "package.json"))

		const repo = pkg.repository
		// A missing/empty repository.url is exactly what npm provenance rejects with E422.
		expect(repo, `${ws}/package.json is missing "repository"`).toBeTypeOf("object")
		expect(repo!.type, `${ws}: repository.type must be "git"`).toBe("git")
		expect(repo!.url, `${ws}: repository.url must be the canonical source repo (with .git)`).toBe(CANONICAL_URL)
		// `directory` lets npm resolve the per-workspace source path under the monorepo.
		expect(repo!.directory, `${ws}: repository.directory must be the workspace path`).toBe(ws)
	})
})
