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
import { collectExportTargets } from "./publish-exports.ts"

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

	// Step 2: verify the tarball is consumer-resolvable (every concrete exports target is shipped).
	verifyPublishExports(tarballPath)

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

/**
 * Verify every concrete `exports` target exists inside the packed tarball. We ship SOURCE + built output + declarations
 * in one package (Node ≥24 type-strips the `node → .ts` condition natively; bundlers/TS take `default`/`types` from
 * `out/`), so the map publishes AS-IS — this guard only proves nothing dangles. It would have caught the v7.2.0
 * ship-break (exports pointing at files the `files` globs excluded) and mailwoman's historically never-shipped
 * `.d.ts`.
 */
function verifyPublishExports(tarballPath: string) {
	const listing = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })

	if (listing.status !== 0) {
		console.error(`publish-workspace: tar -tzf failed (exit ${listing.status})`)
		process.exit(listing.status ?? 1)
	}
	const shipped = new Set(listing.stdout.split("\n").map((line) => line.replace(/^package\//, "./")))
	const manifestRead = spawnSync("tar", ["-xzf", tarballPath, "-O", "package/package.json"], { encoding: "utf8" })

	if (manifestRead.status !== 0) {
		console.error(`publish-workspace: could not read package.json from tarball (exit ${manifestRead.status})`)
		process.exit(manifestRead.status ?? 1)
	}
	const manifest = JSON.parse(manifestRead.stdout)
	const offenders = collectExportTargets(manifest.exports ?? {}).filter((target) => !shipped.has(target))

	if (offenders.length > 0) {
		console.error(`publish-workspace: UNRESOLVABLE PUBLISH MAP for ${manifest.name} — refusing to publish:`)

		for (const line of offenders) {
			console.error(`  - ${line} (not present in the tarball)`)
		}
		process.exit(1)
	}
	console.error(
		`publish-workspace: exports verified for ${manifest.name} (${collectExportTargets(manifest.exports ?? {}).length} targets shipped)`
	)
}

// dereferenceWorkspaceSymlinks moved to pack-workspace.ts (2026-07-23) so packWorkspaceForPublish
// derefs for EVERY caller (smoke included); the explicit call above stays as the documented
// safety net (AGENTS.md "symlinks in the publish tarball").
