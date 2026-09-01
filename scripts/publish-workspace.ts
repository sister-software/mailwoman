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
 *        condition is rewritten to emitted JavaScript (the repo runs source under node; consumers get `out/`). The dev
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

import { $private, $public } from "@mailwoman/core/env"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { repoRootPath } from "@mailwoman/core/paths"
import { spawnProcessSync } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { dereferenceWorkspaceSymlinks, packWorkspaceForPublish } from "./pack-workspace.ts"
import { formatTarballAudit, verifyTarball } from "./verify-tarball.ts"

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
const isWeightsWorkspace = workspacePath.startsWith("./packages/neural-weights-")

if (SKIP_WEIGHTS && isWeightsWorkspace) {
	console.error(`publish-workspace: MAILWOMAN_SKIP_WEIGHTS set — skipping ${workspacePath}`)

	process.exit(0)
}

const cwd = resolvePath(repoRoot, workspacePath)

// Dereference any symlinks among the workspace's `files` entries before
// publishing — npm/yarn refuse to upload tarballs containing symlinks
// (registry returns HTTP 415). The neural-weights workspaces in particular
// can end up with symlinks from `scripts/link-dev-weights.ts`.
await dereferenceWorkspaceSymlinks(cwd)

await using tmpDir = await temporaryDirectory("mailwoman-publish-")
const tarballPath = tmpDir.resolve("package.tgz")

// Step 1: pack with the derived publish map injected (shared helper — same path the CI
// smoke test uses, so what we test is what we ship).
console.error(`publish-workspace: packing ${workspacePath} with injected publish exports`)

await packWorkspaceForPublish(cwd, tarballPath)

// Step 2: verify the tarball contains what the manifest promises — every concrete exports target,
// every literal `files` entry (see verify-tarball.ts for the en-in incident that guard exists for),
// and every `bin` target.
try {
	const audit = verifyTarball(tarballPath)

	console.error(`publish-workspace: verified ${audit.name} (${formatTarballAudit(audit)})`)
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

// npm can only mint a provenance attestation from a CI provider it supports, so this is gated on GitHub Actions
// rather than on CI generally: a local `yarn release` passing --provenance fails outright, with no OIDC token to
// sign against. Trusted Publishing works either way — the attestation is the part that needs the CI identity.
//
// MAILWOMAN_NPM_PROVENANCE=0 turns it off, so a release blocked by a sigstore or registry outage can still ship.
if ($public.GITHUB_ACTIONS && $public.MAILWOMAN_NPM_PROVENANCE !== "0") {
	publishArgs.push("--provenance")
}

console.error(`publish-workspace: ${dryRun ? "[dry-run] " : ""}npm ${publishArgs.join(" ")}`)

if (dryRun) {
	process.exit(0)
}

const publishResult = spawnProcessSync("npm", publishArgs, { stdio: ["inherit", "inherit", "pipe"] })
const stderr = publishResult.stderr?.toString() ?? ""

if (publishResult.status !== 0 && /cannot publish over the previously published version/i.test(stderr)) {
	console.error(`publish-workspace: ${workspacePath} already published at this version — skipping (tolerate-republish)`)

	process.exit(0)
}

if (stderr) {
	process.stderr.write(stderr)
}

process.exit(publishResult.status ?? 1)

// The tarball audit moved to verify-tarball.ts (2026-08-02) so BOTH publish paths inherit it —
// `bless-package.ts` packs the first publish of a package and had no guard at all, which is how
// neural-weights-en-in@8.6.0 shipped without the one binary it exists to carry.

// dereferenceWorkspaceSymlinks moved to pack-workspace.ts (2026-07-23) so packWorkspaceForPublish
// derefs for EVERY caller (smoke included); the explicit call above stays as the documented
// safety net (AGENTS.md "symlinks in the publish tarball").
