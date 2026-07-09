#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Copy the trained neural model + tokenizer into each `neural-weights-<locale>` workspace so `npm
 *   publish` picks them up via the package's `files` glob. The workspace dirs hold only metadata in
 *   git (gitignored model.onnx + tokenizer.model); this script materializes the binaries at release
 *   time.
 *
 *   The source model + tokenizer paths come from `release.config.json` (`weights.dataRoot` +
 *   `weights.model` / `weights.tokenizer`) so the version-bearing filenames live in one place
 *   rather than hardcoded here. Override at release time via env vars:
 *
 *   - MAILWOMAN_DATA_ROOT: override `weights.dataRoot` (the machine's data dir)
 *   - MAILWOMAN_PUBLISH_MODEL: absolute path to the int8 quantized model.onnx (wins outright)
 *   - MAILWOMAN_PUBLISH_TOKENIZER: absolute path to the matching tokenizer.model (wins outright)
 *
 *   Also materializes the #718 D1 SOFT-FEED artifacts so the library default `loadFromWeights` feeds
 *   the anchor + gazetteer channels the trained model expects (without these, the package's default
 *   load path serves the model anchor-OFF — the #566/#685 OOD crater):
 *
 *   - `postcode-<cc>.bin` — the compact PCB1 postcode-anchor binary, built from the WOF postcode shard
 *       (`softFeed.postcodeDBByCountry[<cc>]`) via `mailwoman gazetteer postcode-binary`.
 *   - `anchor-lexicon-v1.json` — the codex-generated gazetteer-anchor lexicon
 *       (`softFeed.gazetteerLexicon`).
 *
 *   Idempotent. Used by .release-it.json's before:init hook.
 */

import { spawnSync } from "node:child_process"
import type { PathLike } from "node:fs"
import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, stat, unlink } from "node:fs/promises"
import { resolve } from "node:path"

import { $public } from "@mailwoman/core/env"
import { runIfScript } from "@mailwoman/core/scripting"
import { repoRootPath } from "@mailwoman/core/utils"

const repoRoot = repoRootPath()

const config = JSON.parse(readFileSync(resolve(repoRoot, "release.config.json"), "utf8"))
const dataRoot = $public.MAILWOMAN_DATA_ROOT ?? config.weights.dataRoot
const SOURCE_MODEL = $public.MAILWOMAN_PUBLISH_MODEL ?? resolve(dataRoot, config.weights.model)
const SOURCE_TOKENIZER = $public.MAILWOMAN_PUBLISH_TOKENIZER ?? resolve(dataRoot, config.weights.tokenizer)

const SOFT_FEED = config.softFeed ?? {}
const SOURCE_GAZETTEER = SOFT_FEED.gazetteerLexicon ? resolve(repoRoot, SOFT_FEED.gazetteerLexicon) : null

const TARGETS = config.locales.map((locale: string) => `neural-weights-${locale}`)

async function exists(path: PathLike) {
	try {
		await stat(path)

		return true
	} catch {
		return false
	}
}

async function main() {
	// CI release workflow sets MAILWOMAN_SKIP_WEIGHTS_COPY=1 when release_weights
	// input is false (the default). Weights binaries live at /mnt/playpen on the
	// operator's host and aren't fetchable from CI; the workflow excludes the
	// weights workspaces from the publish set in that mode, so skipping the
	// copy is correct.
	if ($public.MAILWOMAN_SKIP_WEIGHTS_COPY) {
		process.stderr.write("copy-weights: MAILWOMAN_SKIP_WEIGHTS_COPY set — skipping.\n")

		return
	}

	if (!(await exists(SOURCE_MODEL))) {
		throw new Error(`Missing source model: ${SOURCE_MODEL}\nSet MAILWOMAN_PUBLISH_MODEL to override.`)
	}

	if (!(await exists(SOURCE_TOKENIZER))) {
		throw new Error(`Missing source tokenizer: ${SOURCE_TOKENIZER}\nSet MAILWOMAN_PUBLISH_TOKENIZER to override.`)
	}

	for (const workspace of TARGETS) {
		const dir = resolve(repoRoot, workspace)
		await mkdir(dir, { recursive: true })
		const modelDest = resolve(dir, "model.onnx")
		const tokenizerDest = resolve(dir, "tokenizer.model")
		// Unlink first so a pre-existing symlink (from link-dev-weights.ts) is
		// replaced with a real file. Otherwise copyFile follows the symlink and
		// writes through it, leaving the symlink in place — which yarn refuses
		// to publish (npm registry rejects symlinks with HTTP 415).
		await removeIfPresent(modelDest)
		await removeIfPresent(tokenizerDest)
		await copyFile(SOURCE_MODEL, modelDest)
		await copyFile(SOURCE_TOKENIZER, tokenizerDest)
		process.stderr.write(`copied weights → ${workspace}/{model.onnx,tokenizer.model}\n`)

		await materializeSoftFeed(workspace, dir)
	}
}

/**
 * Materialize the #718 D1 soft-feed artifacts into a weights workspace: the gazetteer-anchor lexicon (a verbatim copy)
 * + the per-country PCB1 postcode-anchor binary (built fresh from the WOF shard). Both `removeIfPresent` first — same
 * symlink-in-tarball trap the model/tokenizer copy guards against.
 */
async function materializeSoftFeed(workspace: string, dir: string) {
	// Gazetteer-anchor lexicon (#464) — a small JSON, copied verbatim from the repo source.
	if (SOURCE_GAZETTEER) {
		if (!(await exists(SOURCE_GAZETTEER))) {
			throw new Error(
				`Missing gazetteer lexicon: ${SOURCE_GAZETTEER}\nSet softFeed.gazetteerLexicon in release.config.json.`
			)
		}
		const dest = resolve(dir, "anchor-lexicon-v1.json")
		await removeIfPresent(dest)
		await copyFile(SOURCE_GAZETTEER, dest)
		process.stderr.write(`copied soft-feed → ${workspace}/anchor-lexicon-v1.json\n`)
	}

	// PCB1 postcode-anchor binary (#240) — built from the locale's WOF postcode shard. The locale's
	// region subtag (`en-us` → `us`) names both the binary and the postcodeDBByCountry source entry.
	const country = workspace.replace(/^neural-weights-[a-z]+-/, "")
	const dbRel = SOFT_FEED.postcodeDBByCountry?.[country]

	if (!dbRel) {
		process.stderr.write(
			`soft-feed: no postcodeDBByCountry entry for "${country}" — skipping ${workspace}/postcode-${country}.bin\n`
		)

		return
	}
	const db = dbRel.startsWith("/") ? dbRel : resolve(dataRoot, "wof", dbRel)

	if (!existsSync(db)) {
		throw new Error(
			`Missing postcode shard for ${country}: ${db}\nSet MAILWOMAN_DATA_ROOT or softFeed.postcodeDBByCountry.`
		)
	}
	const binDest = resolve(dir, `postcode-${country}.bin`)
	await removeIfPresent(binDest)
	// `gazetteer postcode-binary` is the compiled Pastel command (ported from the old
	// scripts/build-postcode-binary.ts). `.release-it.json` runs `yarn compile` right before this
	// script, so mailwoman/out/cli.js exists. --out is the workspace dir, so the command writes
	// postcode-<cc>.bin directly where the `files` array expects it.
	const cli = resolve(repoRoot, "mailwoman/out/cli.js")
	const r = spawnSync(
		process.execPath,
		[cli, "gazetteer", "postcode-binary", "--out", dir, "--locale", `${country.toUpperCase()}:${db}`],
		{ stdio: "inherit" }
	)

	if (r.status !== 0) throw new Error(`gazetteer postcode-binary failed for ${country} (exit ${r.status})`)

	if (!existsSync(binDest)) throw new Error(`gazetteer postcode-binary ran but ${binDest} was not produced`)
	process.stderr.write(`built soft-feed → ${workspace}/postcode-${country}.bin\n`)
}

async function removeIfPresent(path: PathLike) {
	try {
		await unlink(path)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
	}
}

runIfScript(import.meta, main)
