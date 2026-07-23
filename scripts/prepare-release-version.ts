#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Phase-1 of the PR-based release flow (2026-07-23): write the target version into the root
 *   `package.json` + every workspace listed in `.release-it.json` — and do NOTHING else. No git, no
 *   tags, no npm. The caller (`publish.yml`'s `prepare` job) commits the result onto a
 *   `release/v<version>` branch and opens the release PR; the tag + npm publish happen in the
 *   separate `publish` phase only after that PR has merged through the "Production Integrity"
 *   ruleset (PR + green `test` required on `main` — the ruleset that rejects release-it's direct
 *   push, see the 2026-07-23 night-2 postmortem).
 *
 *   The workspace list is read from `.release-it.json` — the SAME list the per-workspace publish
 *   loop derives (#756: one source of truth, so this script can't drift from what actually
 *   publishes). Semver parsing/increment is the `semver` package (root devDependency), so the
 *   script requires `yarn install` first — which every caller does anyway.
 *
 *   Output contract: prints `RESOLVED_VERSION=<x.y.z>` on success — the workflow greps this line
 *   (no $GITHUB_OUTPUT / env access here; scripts stay env-free per the repo's blessed-env rule).
 *
 *   Flags (native parseArgs):
 *
 *   - `--version <patch|minor|major|x.y.z>` (required) — increment keyword (from the root version)
 *       or an explicit target. An explicit target must be strictly greater than the current root
 *       version.
 *   - `--check-only` — resolve + validate + print, but write nothing (the dry-run path).
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import semver from "semver"

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		"check-only": { type: "boolean", default: false },
	},
})

const repoRoot = resolve(import.meta.dirname, "..")

function fail(message: string): never {
	console.error(`prepare-release-version: ${message}`)
	process.exit(1)
}

if (!values.version) {
	fail("--version is required (patch | minor | major | x.y.z)")
}

const rootManifestPath = resolve(repoRoot, "package.json")
const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8")) as { version?: string }

if (typeof rootManifest.version !== "string" || !semver.valid(rootManifest.version)) {
	fail(`root package.json version is not a valid semver: ${String(rootManifest.version)}`)
}

let targetVersion: string

if (values.version === "major" || values.version === "minor" || values.version === "patch") {
	targetVersion =
		semver.inc(rootManifest.version, values.version) ?? fail(`semver.inc failed on ${rootManifest.version}`)
} else {
	const explicit = semver.valid(values.version)

	if (!explicit) {
		fail(`not a valid semver or increment keyword: "${values.version}"`)
	}

	if (!semver.gt(explicit, rootManifest.version)) {
		fail(`explicit target ${explicit} is not greater than the current root version ${rootManifest.version}`)
	}

	targetVersion = explicit
}

// The SAME workspace list the publish loop uses (#756) — root + these is the full bump surface.
const releaseItConfig = JSON.parse(readFileSync(resolve(repoRoot, ".release-it.json"), "utf8")) as {
	plugins: { "@release-it-plugins/workspaces": { workspaces: string[] } }
}
const workspaces = releaseItConfig.plugins["@release-it-plugins/workspaces"].workspaces

if (!Array.isArray(workspaces) || workspaces.length === 0) {
	fail(".release-it.json workspace list is empty")
}

const manifestPaths = [rootManifestPath, ...workspaces.map((ws) => resolve(repoRoot, ws, "package.json"))]

// Validate the whole set BEFORE writing anything — a half-bumped tree is worse than a failed run.
const parsed = manifestPaths.map((path) => {
	const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

	if (typeof manifest.version !== "string") {
		fail(`${path} has no version field`)
	}

	return { path, manifest }
})

for (const { path, manifest } of parsed) {
	if (manifest.version !== rootManifest.version) {
		fail(
			`${path} is at ${String(manifest.version)} but the root is at ${rootManifest.version} — ` +
				`the tree is not version-synced; refusing to bump on top of drift`
		)
	}
}

if (!values["check-only"]) {
	for (const { path, manifest } of parsed) {
		manifest.version = targetVersion
		writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`)
	}

	console.log(`bumped ${parsed.length} manifests (root + ${workspaces.length} workspaces) to ${targetVersion}`)
}

console.log(`RESOLVED_VERSION=${targetVersion}`)
