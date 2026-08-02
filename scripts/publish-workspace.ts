#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publish a single workspace. Invoked by `@release-it-plugins/workspaces` once per non-private
 *   workspace.
 *
 *   Three-step flow:
 *
 *   1. `yarn pack -o <tmpfile>` — yarn 4 translates `workspace:*` deps to the concrete sibling version
 *        while building the tarball. npm's own publish step does NOT do this translation, and
 *        shipping `workspace:*` to consumers breaks `npm install` (EUNSUPPORTEDPROTOCOL).
 *   2. Derive the PUBLISH exports map from the dev map inside the tarball — every `node → .ts`
 *        condition is stripped (the repo runs source under node; consumers get `out/`). The dev
 *        `exports` in each workspace's package.json is the single source of truth; there is no
 *        hand-maintained `publishConfig.exports` (that duplication shipped a fully-broken v7.2.0
 *        when it was removed without a replacement — this transform IS the replacement). A guard
 *        then fails the publish if any exported target still ends in `.ts`/`.tsx` or points at a
 *        file the tarball doesn't contain.
 *   3. `npm publish <tmpfile>` — npm CLI is the right tool for the actual publish because it
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
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { $private, $public } from "@mailwoman/core/env"
import { repoRootPath } from "@mailwoman/core/utils"

import { dereferenceWorkspaceSymlinks, packWorkspaceForPublish } from "./pack-workspace.ts"
import { verifyTarball } from "./verify-tarball.ts"

const repoRoot = repoRootPath()

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
	// Step 1: pack with the derived publish map injected (shared helper — same path the CI
	// smoke test uses, so what we test is what we ship).
	console.error(`publish-workspace: packing ${workspacePath} with injected publish exports`)

	packWorkspaceForPublish(cwd, tarballPath)

	// Step 2: verify the tarball contains what the manifest promises — every concrete exports target
	// AND every literal `files` entry (see verify-tarball.ts for the en-in incident this second
	// guard exists for).
	try {
		const audit = verifyTarball(tarballPath)

		console.error(
			`publish-workspace: verified ${audit.name} (${audit.exportTargets} exports targets, ${audit.literalFiles} literal files)`
		)
	} catch (error) {
		console.error(error instanceof Error ? error.message : error)

		process.exit(1)
	}

	// Step 3: npm publish <tarball> — npm CLI auto-detects OIDC environment
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

// The tarball audit moved to verify-tarball.ts (2026-08-02) so BOTH publish paths inherit it —
// `bless-package.ts` packs the first publish of a package and had no guard at all, which is how
// neural-weights-en-in@8.6.0 shipped without the one binary it exists to carry.

// dereferenceWorkspaceSymlinks moved to pack-workspace.ts (2026-07-23) so packWorkspaceForPublish
// derefs for EVERY caller (smoke included); the explicit call above stays as the documented
// safety net (AGENTS.md "symlinks in the publish tarball").
