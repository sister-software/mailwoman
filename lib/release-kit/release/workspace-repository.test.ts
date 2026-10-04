import { readPackageJSON } from "@mailwoman/core/module/resolve-from"
import { repoRootPath } from "@mailwoman/core/paths"
import { resolvePath } from "path-ts"
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fail-fast guard for the npm-provenance `repository` requirement. Every npm publish is
 *   provenance-signed. Sigstore provenance verification rejects (HTTP 422) any workspace
 *   whose `package.json` lacks a `repository.url` matching the source repo. This asserts every
 *   workspace in the `.release-it.json` publish set includes the canonical `repository` block, so a
 *   drift fails at PR/CI time instead of mid-release.
 */
import { describe, expect, it } from "vitest"

import { releaseWorkspaces } from "#release-kit/release/stage"

const repoRoot = repoRootPath()
const CANONICAL_URL = "https://github.com/sister-software/mailwoman.git"

const workspaces = await releaseWorkspaces(repoRoot)

describe("#757 release provenance: every published workspace declares its repository", () => {
	it.each(workspaces)("%s/package.json has the canonical repository block", async (ws) => {
		const pkg = await readPackageJSON(resolvePath(repoRoot, ws, "package.json"))

		const repo = pkg.repository

		// npm accepts a shorthand string here, but that form has no `directory`.
		// A missing or empty repository.url is what npm provenance rejects with E422.
		if (typeof repo !== "object") {
			throw new TypeError(`${ws}/package.json must declare "repository" as an object, not ${typeof repo}`)
		}

		expect(repo.type, `${ws}: repository.type must be "git"`).toBe("git")
		expect(repo.url, `${ws}: repository.url must be the canonical source repo (with .git)`).toBe(CANONICAL_URL)
		// `directory` lets npm resolve the per-workspace source path under the monorepo.
		expect(repo.directory, `${ws}: repository.directory must be the workspace path`).toBe(ws)
	})
})
