/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publish a single workspace. Invoked by `@release-it-plugins/workspaces` once per non-private
 *   workspace, and by `publish.yml`'s per-workspace loop.
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
 *   Per-workspace skip: MAILWOMAN_SKIP_WEIGHTS=1 makes this operation answer `skipped` for the
 *   neural-weights-* workspaces. CI release workflow uses this when its `release_weights` input is false
 *   — keeps the monorepo version-synced in git while npm doesn't see a weights tick.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { spawnProcessSync } from "@mailwoman/core/process"
import { resolvePath } from "path-ts"

import { $private, $public } from "#env/index"
import { dereferenceWorkspaceSymlinks, packWorkspaceForPublish } from "#pack/pack-workspace"
import { formatTarballAudit, verifyTarball } from "#pack/verify-tarball"

export interface PublishWorkspaceOptions {
	repoRoot: string
	/**
	 * `./<workspace>` — the plugin's `RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE` shape.
	 */
	workspacePath: string
	tag: string
	access: string
	otp: string
	dryRun: boolean
	log: (line: string) => void
}

export interface PublishWorkspaceReport {
	workspace: string
	outcome: "published" | "skipped-weights" | "already-published" | "dry-run"
	tarballAudit?: string
}

/**
 * The plugin's environment contract, read once so the operation's schema can default from it.
 */
export function releaseItWorkspaceEnvironment(): {
	workspacePath: string | undefined
	tag: string
	access: string
	otp: string
	dryRun: boolean
} {
	return {
		workspacePath: $public.RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE,
		tag: $public.RELEASE_IT_WORKSPACES_TAG || "latest",
		access: $public.RELEASE_IT_WORKSPACES_ACCESS || "",
		otp: $private.RELEASE_IT_WORKSPACES_OTP || "",
		dryRun: $public.RELEASE_IT_WORKSPACES_DRY_RUN === "true",
	}
}

export async function publishWorkspace(options: PublishWorkspaceOptions): Promise<PublishWorkspaceReport> {
	const { repoRoot, workspacePath, log } = options

	const skipWeights = !!$public.MAILWOMAN_SKIP_WEIGHTS
	const isWeightsWorkspace = workspacePath.startsWith("./packages/neural-weights-")

	if (skipWeights && isWeightsWorkspace) {
		log(`publish-workspace: MAILWOMAN_SKIP_WEIGHTS set — skipping ${workspacePath}`)

		return { workspace: workspacePath, outcome: "skipped-weights" }
	}

	const cwd = resolvePath(repoRoot, workspacePath)

	// Dereference any symlinks among the workspace's `files` entries before
	// publishing — npm/yarn refuse to upload tarballs containing symlinks
	// (registry returns HTTP 415). The neural-weights workspaces in particular
	// can end up with symlinks from a dev linker.
	await dereferenceWorkspaceSymlinks(cwd)

	await using tmpDir = await temporaryDirectory("mailwoman-publish-")
	const tarballPath = tmpDir.resolve("package.tgz")

	// Step 1: pack with the derived publish map injected (shared helper — same path the CI
	// smoke test uses, so what we test is what we ship).
	log(`publish-workspace: packing ${workspacePath} with injected publish exports`)

	await packWorkspaceForPublish(cwd, tarballPath)

	// Step 2: verify the tarball contains what the manifest promises — every concrete exports target,
	// every literal `files` entry (see verify-tarball.ts for the en-in incident that guard exists for),
	// and every `bin` target. Throws with every violation listed.
	const audit = verifyTarball(tarballPath)
	const tarballAudit = formatTarballAudit(audit)

	log(`publish-workspace: verified ${audit.name} (${tarballAudit})`)

	// Step 3: npm publish <tarball> — npm CLI auto-detects OIDC environment
	// in GitHub Actions and uses it for Trusted Publishing.
	const publishArgs = ["publish", tarballPath, "--tag", options.tag]

	if (options.access) {
		publishArgs.push("--access", options.access)
	}

	if (options.otp) {
		publishArgs.push("--otp", options.otp)
	}

	// npm can only mint a provenance attestation from a CI provider it supports, so this is conditioned on GitHub Actions
	// rather than on CI generally: a local `yarn release` passing --provenance fails outright, with no OIDC token to
	// sign against. Trusted Publishing works either way — the attestation is the part that needs the CI identity.
	//
	// MAILWOMAN_NPM_PROVENANCE=0 turns it off, so a release blocked by a sigstore or registry outage can still ship.
	if ($public.GITHUB_ACTIONS && $public.MAILWOMAN_NPM_PROVENANCE !== "0") {
		publishArgs.push("--provenance")
	}

	log(`publish-workspace: ${options.dryRun ? "[dry-run] " : ""}npm ${publishArgs.join(" ")}`)

	if (options.dryRun) {
		return { workspace: workspacePath, outcome: "dry-run", tarballAudit }
	}

	const publishResult = spawnProcessSync("npm", publishArgs, { stdio: ["inherit", "inherit", "pipe"] })
	const stderr = publishResult.stderr?.toString() ?? ""

	if (publishResult.status !== 0 && /cannot publish over the previously published version/i.test(stderr)) {
		log(`publish-workspace: ${workspacePath} already published at this version — skipping (tolerate-republish)`)

		return { workspace: workspacePath, outcome: "already-published", tarballAudit }
	}

	if (stderr) {
		process.stderr.write(stderr)
	}

	if (publishResult.status !== 0) {
		throw new Error(`publish-workspace: npm publish exited ${publishResult.status ?? "by signal"} for ${workspacePath}`)
	}

	return { workspace: workspacePath, outcome: "published", tarballAudit }
}

// The tarball audit lives in verify-tarball.ts so BOTH publish paths inherit it — `bless-package` packs
// the first publish of a package and had no guard at all, which is how neural-weights-en-in@8.6.0
// shipped without the one binary it exists to carry.

// dereferenceWorkspaceSymlinks lives in pack-workspace.ts so packWorkspaceForPublish derefs for EVERY
// caller (smoke included); the explicit call above stays as the documented safety net (AGENTS.md
// "symlinks in the publish tarball").
