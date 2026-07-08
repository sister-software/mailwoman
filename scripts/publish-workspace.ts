#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publish a single workspace. Invoked by `@release-it-plugins/workspaces` once per non-private
 *   workspace.
 *
 *   Two-step flow:
 *
 *   1. `yarn pack -o <tmpfile>` — yarn 4 translates `workspace:*` deps to the concrete sibling version
 *        while building the tarball. npm's own publish step does NOT do this translation, and
 *        shipping `workspace:*` to consumers breaks `npm install` (EUNSUPPORTEDPROTOCOL).
 *   2. `npm publish <tmpfile>` — npm CLI is the right tool for the actual publish because it
 *        auto-detects GitHub Actions' OIDC environment and uses it for Trusted Publishing. Yarn's
 *        `yarn npm publish` doesn't integrate with npm's OIDC flow.
 *
 *   Env contract from the plugin (see node_modules/@release-it-plugins/workspaces/index.js):
 *
 *   - RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: ./<workspace>
 *   - RELEASE_IT_WORKSPACES_TAG: dist-tag (latest / next / etc.)
 *   - RELEASE_IT_WORKSPACES_ACCESS: "public" / "restricted"
 *   - RELEASE_IT_WORKSPACES_OTP: one-time password (may be empty)
 *   - RELEASE_IT_WORKSPACES_DRY_RUN: "true" / "false"
 *
 *   Per-workspace skip: MAILWOMAN_SKIP_WEIGHTS=1 makes this script exit 0 for the neural-weights-*
 *   workspaces. CI release workflow uses this when its `release_weights` input is false — keeps the
 *   monorepo version-synced in git while npm doesn't see a weights tick.
 */

import { spawnSync } from "node:child_process"
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { $private, $public } from "@mailwoman/core/env"
import { repoRootPathBuilder } from "@mailwoman/core/utils"

const repoRoot = String(repoRootPathBuilder())

const workspacePath = $public.RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE
const tag = $public.RELEASE_IT_WORKSPACES_TAG || "latest"
const access = $public.RELEASE_IT_WORKSPACES_ACCESS || ""
const otp = $private.RELEASE_IT_WORKSPACES_OTP || ""
const dryRun = $public.RELEASE_IT_WORKSPACES_DRY_RUN === "true"

if (!workspacePath) {
	console.error("publish-workspace.ts: RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE unset")
	process.exit(2)
}

const SKIP_WEIGHTS = !!$public.MAILWOMAN_SKIP_WEIGHTS
const isWeightsWorkspace = workspacePath.startsWith("./neural-weights-")

if (SKIP_WEIGHTS && isWeightsWorkspace) {
	console.error(`publish-workspace: MAILWOMAN_SKIP_WEIGHTS set — skipping ${workspacePath}`)
	process.exit(0)
}

const cwd = resolve(repoRoot, workspacePath)

// Dereference any symlinks among the workspace's `files` entries before
// publishing — npm/yarn refuse to upload tarballs containing symlinks
// (registry returns HTTP 415). The neural-weights workspaces in particular
// can end up with symlinks from `scripts/link-dev-weights.ts`.
dereferenceWorkspaceSymlinks(cwd)

const tmpDir = mkdtempSync(join(tmpdir(), "mailwoman-publish-"))
const tarballPath = join(tmpDir, "package.tgz")

try {
	// Step 1: yarn pack — produces a tarball with workspace:* deps translated
	// to concrete versions.
	const packArgs = ["pack", "-o", tarballPath]
	console.error(`publish-workspace: yarn ${packArgs.join(" ")} (cwd: ${cwd})`)
	const packResult = spawnSync("yarn", packArgs, { cwd, stdio: "inherit" })

	if (packResult.status !== 0) {
		console.error(`publish-workspace: yarn pack failed (exit ${packResult.status})`)
		process.exit(packResult.status ?? 1)
	}

	// Step 2: npm publish <tarball> — npm CLI auto-detects OIDC environment
	// in GitHub Actions and uses it for Trusted Publishing.
	const publishArgs = ["publish", tarballPath, "--tag", tag]

	if (access) {
		publishArgs.push("--access", access)
	}

	if (otp) {
		publishArgs.push("--otp", otp)
	}

	// --provenance is opt-in via MAILWOMAN_NPM_PROVENANCE=1. The npm registry
	// rejects --provenance on private source repositories with E422 because
	// sigstore attestations link to source code that third parties can't
	// verify. Trusted Publishing itself works fine without --provenance; flip
	// the env var on once the repo goes public.
	if ($public.MAILWOMAN_NPM_PROVENANCE === "1") {
		publishArgs.push("--provenance")
	}

	console.error(`publish-workspace: ${dryRun ? "[dry-run] " : ""}npm ${publishArgs.join(" ")}`)

	if (dryRun) {
		process.exit(0)
	}

	const publishResult = spawnSync("npm", publishArgs, { stdio: ["inherit", "inherit", "pipe"] })
	const stderr = publishResult.stderr?.toString() ?? ""

	if (publishResult.status !== 0 && /cannot publish over the previously published version/i.test(stderr)) {
		console.error(
			`publish-workspace: ${workspacePath} already published at this version — skipping (tolerate-republish)`
		)
		process.exit(0)
	}

	if (stderr) {
		process.stderr.write(stderr)
	}
	process.exit(publishResult.status ?? 1)
} finally {
	rmSync(tmpDir, { recursive: true, force: true })
}

/**
 * Replace any symlinked `files` entries with real copies of their targets.
 */
function dereferenceWorkspaceSymlinks(workspaceDir: string) {
	const pkg = JSON.parse(readFileSync(resolve(workspaceDir, "package.json"), "utf8"))

	for (const entry of pkg.files ?? []) {
		if (typeof entry !== "string" || /[*?[{]/.test(entry)) continue // skip globs
		const target = resolve(workspaceDir, entry)
		const st = lstatSync(target, { throwIfNoEntry: false })

		if (!st?.isSymbolicLink()) continue
		const linkDest = readlinkSync(target)
		const resolved = resolve(dirname(target), linkDest)
		unlinkSync(target)
		copyFileSync(resolved, target)
		console.error(`publish-workspace: dereferenced ${entry} ← ${resolved}`)
	}
}
