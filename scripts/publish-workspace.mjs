#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publish a single workspace via `yarn npm publish`. Invoked by `@release-it-plugins/workspaces`
 *   once per non-private workspace.
 *
 *   Why this exists: the plugin's default publish command is `npm publish ./<workspace>`. npm's
 *   publish step does NOT translate yarn 4's `workspace:*` protocol — packages ship with
 *   unresolvable deps and consumers hit `EUNSUPPORTEDPROTOCOL`. `yarn npm publish` IS aware of the
 *   workspace protocol and rewrites it to the concrete version at publish time.
 *
 *   This script reads the plugin's env vars and constructs the right `yarn npm publish` call.
 *
 *   Env contract from the plugin (see node_modules/@release-it-plugins/workspaces/index.js):
 *
 *   - RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE: ./<workspace>
 *   - RELEASE_IT_WORKSPACES_TAG: dist-tag (latest / next / etc.)
 *   - RELEASE_IT_WORKSPACES_ACCESS: "public" / "restricted"
 *   - RELEASE_IT_WORKSPACES_OTP: one-time password (may be empty)
 *   - RELEASE_IT_WORKSPACES_DRY_RUN: "true" / "false"
 */

import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const workspacePath = process.env.RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE
const tag = process.env.RELEASE_IT_WORKSPACES_TAG || "latest"
const access = process.env.RELEASE_IT_WORKSPACES_ACCESS || ""
const otp = process.env.RELEASE_IT_WORKSPACES_OTP || ""
const dryRun = process.env.RELEASE_IT_WORKSPACES_DRY_RUN === "true"

if (!workspacePath) {
	console.error("publish-workspace.mjs: RELEASE_IT_WORKSPACES_PATH_TO_WORKSPACE unset")
	process.exit(2)
}

const args = ["npm", "publish", "--tag", tag, "--tolerate-republish"]
if (access) args.push("--access", access)
if (otp) args.push("--otp", otp)
// yarn npm publish doesn't have a --dry-run; emulate by skipping the spawn.
const cwd = resolve(repoRoot, workspacePath)

console.error(`publish-workspace: ${dryRun ? "[dry-run] " : ""}yarn ${args.join(" ")} (cwd: ${cwd})`)
if (dryRun) {
	process.exit(0)
}

const result = spawnSync("yarn", args, { cwd, stdio: "inherit" })
process.exit(result.status ?? 1)
