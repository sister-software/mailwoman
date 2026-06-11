#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Publish a model release to the HF Bucket (en-us/<version>/) AND to the standalone HF model repo
 *   (sister-software/mailwoman-<locale>). Verifies every required artifact is uploaded before
 *   exiting so the demo never 404s on a missing file.
 *
 *   Required artifacts per release:
 *
 *   - Model.onnx — int8-quantized classifier
 *   - Tokenizer.model — SentencePiece tokenizer
 *   - Model-card.json — training provenance
 *   - Fst-en-US.bin — FST gazetteer (or whatever locale)
 *   - Wof-hot.db — slim WOF database for browser resolver
 *
 *   After upload, releases.json is updated in-place and re-uploaded.
 *
 *   Usage: HF_TOKEN=... node scripts/publish-release-to-hf.mjs\
 *   --version v0.5.4\
 *   --locale en-us\
 *   --model /path/to/model-int8.onnx\
 *   --tokenizer /path/to/tokenizer.model\
 *   --model-card /path/to/model-card.json\
 *   --fst /path/to/fst-en-US.bin\
 *   --wof-hot /path/to/wof-hot.db\
 *   --gazetteer-lexicon data/gazetteer/anchor-lexicon-v1.json\
 *   --label "v0.5.4 — multi-script tokenizer"\
 *   --description "Multi-script tokenizer..."\
 *   --set-default
 */

import { spawnSync } from "node:child_process"
import { existsSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const REQUIRED_FILES = [
	{ flag: "--model", remoteName: "model.onnx", description: "ONNX classifier" },
	{ flag: "--tokenizer", remoteName: "tokenizer.model", description: "SentencePiece tokenizer" },
	{ flag: "--model-card", remoteName: "model-card.json", description: "Model card JSON" },
	{ flag: "--fst", remoteName: "fst-en-US.bin", description: "FST gazetteer (filename varies by locale)" },
	{ flag: "--wof-hot", remoteName: "wof-hot.db", description: "Slim WOF DB for browser resolver" },
]

const BUCKET_PATH = "hf://buckets/sister-software/mailwoman"
const BUCKET_RESOLVE = "https://huggingface.co/buckets/sister-software/mailwoman/resolve"

function parseArgs() {
	const args = process.argv.slice(2)
	const out = { setDefault: false }
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--set-default") {
			out.setDefault = true
		} else if (arg.startsWith("--") && i + 1 < args.length) {
			const key = arg.slice(2).replace(/-./g, (m) => m[1].toUpperCase())
			out[key] = args[++i]
		}
	}
	return out
}

function fail(msg) {
	console.error(`✗ ${msg}`)
	process.exit(1)
}

function run(cmd, args) {
	const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env } })
	if (r.status !== 0) fail(`${cmd} ${args.join(" ")} → exit ${r.status}`)
}

function runCapture(cmd, args) {
	const r = spawnSync(cmd, args, { encoding: "utf8" })
	return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" }
}

async function checkRemoteFileExists(url) {
	try {
		const res = await fetch(url, { method: "HEAD", redirect: "follow" })
		return res.ok
	} catch {
		return false
	}
}

async function main() {
	const args = parseArgs()

	if (!args.version) fail("--version required (e.g. v0.5.4)")
	if (!args.locale) fail("--locale required (e.g. en-us)")
	if (!args.label) fail("--label required")
	if (!args.description) fail("--description required")

	// Adapt remote FST filename to the locale, in BCP-47 casing (lowercase language subtag,
	// uppercase region subtag): "en-us" -> "en-US" -> "fst-en-US.bin". This MUST match the exact
	// name the demo fetches (docs/src/shared/resources.tsx → "fst-en-US.bin"); a casing mismatch
	// 404s the gazetteer at runtime. (Previously `locale.toUpperCase()` produced "fst-EN-US.bin".)
	const bcp47 = args.locale
		.split("-")
		.map((part, i) => (i === 0 ? part.toLowerCase() : part.toUpperCase()))
		.join("-")
	const fstRemoteName = `fst-${bcp47}.bin`
	REQUIRED_FILES[3].remoteName = fstRemoteName

	console.error(`Publishing ${args.version} (${args.locale}) to HF Bucket...`)

	// --- Phase 1: verify all local files exist ---
	for (const f of REQUIRED_FILES) {
		const flagKey = f.flag.slice(2).replace(/-./g, (m) => m[1].toUpperCase())
		const localPath = args[flagKey]
		if (!localPath) fail(`${f.flag} (${f.description}) is required`)
		if (!existsSync(localPath)) fail(`${localPath} does not exist`)
		const size = statSync(localPath).size
		if (size === 0) fail(`${localPath} is empty`)
		console.error(`  ✓ ${f.remoteName}: ${localPath} (${(size / 1024 / 1024).toFixed(1)} MB)`)
	}

	// Optional postcode binaries for the anchor channel (#240): comma-separated --postcodes paths
	// (e.g. postcode-us.bin,postcode-de.bin). Uploaded under the version dir by basename; the demo
	// fetches them when the release's `hasAnchor` flag is set.
	const postcodeBins = args.postcodes
		? args.postcodes
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: []
	for (const localPath of postcodeBins) {
		if (!existsSync(localPath) || statSync(localPath).size === 0) fail(`postcode binary ${localPath} missing/empty`)
	}

	// Optional gazetteer-anchor lexicon (#464): a single --gazetteer-lexicon path, uploaded as
	// anchor-lexicon-v1.json. REQUIRED for gazetteer-trained models (v4.2.0+, ONNX declares
	// gazetteer_features) — the demo loader fetches it beside model.onnx and degrades LOUDLY
	// (console.error + zero-filled clues = the measured zero-fill quality trap) when it 404s.
	const gazetteerLexicon = args.gazetteerLexicon || null
	if (gazetteerLexicon && (!existsSync(gazetteerLexicon) || statSync(gazetteerLexicon).size === 0)) {
		fail(`gazetteer lexicon ${gazetteerLexicon} missing/empty`)
	}

	// Optional crisp-polygon DB (build-wof-polygons.mjs): a single --polygons path. Uploaded as
	// wof-polygons.db; the demo draws the real admin boundary instead of the bbox when `hasPolygons`
	// is set. Sibling of wof-hot.db, keyed by the same WOF ids.
	const polygonsDb = args.polygons || null
	if (polygonsDb && (!existsSync(polygonsDb) || statSync(polygonsDb).size === 0)) {
		fail(`polygon DB ${polygonsDb} missing/empty`)
	}

	// --- Phase 2: upload to bucket ---
	const remoteBase = `${args.locale}/${args.version}`
	for (const f of REQUIRED_FILES) {
		const flagKey = f.flag.slice(2).replace(/-./g, (m) => m[1].toUpperCase())
		const localPath = args[flagKey]
		const dst = `${BUCKET_PATH}/${remoteBase}/${f.remoteName}`
		console.error(`  → ${dst}`)
		run("hf", ["buckets", "cp", localPath, dst])
	}
	for (const localPath of postcodeBins) {
		const remoteName = localPath.split("/").pop()
		const dst = `${BUCKET_PATH}/${remoteBase}/${remoteName}`
		console.error(`  → ${dst}`)
		run("hf", ["buckets", "cp", localPath, dst])
	}
	if (gazetteerLexicon) {
		const dst = `${BUCKET_PATH}/${remoteBase}/anchor-lexicon-v1.json`
		console.error(`  → ${dst}`)
		run("hf", ["buckets", "cp", gazetteerLexicon, dst])
	}
	if (polygonsDb) {
		const dst = `${BUCKET_PATH}/${remoteBase}/wof-polygons.db`
		console.error(`  → ${dst}`)
		run("hf", ["buckets", "cp", polygonsDb, dst])
	}

	// --- Phase 3: verify each artifact is reachable via the resolve URL ---
	console.error(`Verifying ${REQUIRED_FILES.length} artifacts via HTTPS...`)
	for (const f of REQUIRED_FILES) {
		const url = `${BUCKET_RESOLVE}/${remoteBase}/${f.remoteName}`
		const ok = await checkRemoteFileExists(url)
		if (!ok) fail(`${f.remoteName} unreachable at ${url}`)
		console.error(`  ✓ ${url}`)
	}

	// --- Phase 4: update releases.json ---
	const releasesUrl = `${BUCKET_RESOLVE}/${args.locale}/releases.json`
	const res = await fetch(releasesUrl, { redirect: "follow" })
	if (!res.ok) fail(`failed to fetch ${releasesUrl}`)
	const releases = await res.json()

	const newEntry = {
		version: args.version,
		label: args.label,
		description: args.description,
		modelSize: args.modelSize ?? `${Math.round(statSync(args.model).size / 1024 / 1024)} MB`,
		tokenizerVocab: 48000,
		steps: args.steps ? parseInt(args.steps, 10) : 100000,
		hasFst: true,
		hasWofDb: true,
		hasAnchor: postcodeBins.length > 0,
		hasPolygons: !!polygonsDb,
	}

	releases.releases = [newEntry, ...releases.releases.filter((r) => r.version !== args.version)]
	if (args.setDefault) releases.defaultVersion = args.version

	const tmpReleases = resolve(tmpdir(), `releases-${args.locale}-${Date.now()}.json`)
	writeFileSync(tmpReleases, JSON.stringify(releases, null, 2))
	run("hf", ["buckets", "cp", tmpReleases, `${BUCKET_PATH}/${args.locale}/releases.json`])
	console.error(`  ✓ releases.json updated, defaultVersion=${releases.defaultVersion}`)

	console.error(`\n✓ ${args.version} (${args.locale}) published successfully.`)
	console.error(`  Demo: https://mailwoman.sister.software/demo/`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
