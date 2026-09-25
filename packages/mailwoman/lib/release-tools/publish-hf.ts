/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { APIClient, isSuccessStatus } from "@mailwoman/core/api"
import { tempRootPath } from "@mailwoman/core/data-root"
import { ByteFormatter } from "@mailwoman/core/fs/formatters"
import { pathExists, readLocalJSONFile, statPath } from "@mailwoman/core/fs/readers"
import { writeLocalJSONFile } from "@mailwoman/core/fs/writers"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { CommandError } from "@mailwoman/core/scripting/command"
import { basename, type PathBuilderLike } from "path-ts"

import { runProcessOrFail } from "#cli/kit/shared"

type RequiredFileOption = "model" | "tokenizer" | "char-vocab" | "model-card"

const OPTION_TO_FIELD = {
	model: "model",
	tokenizer: "tokenizer",
	"char-vocab": "charVocab",
	"model-card": "modelCard",
} as const satisfies Record<RequiredFileOption, keyof PublishHFOptions>

interface RequiredFile {
	option: RequiredFileOption
	remoteName: string
	description: string
}

const REQUIRED_FILES: RequiredFile[] = [
	{ option: "model", remoteName: "model.onnx", description: "ONNX classifier" },
	{ option: "tokenizer", remoteName: "tokenizer.model", description: "SentencePiece tokenizer" },
	{ option: "model-card", remoteName: "model-card.json", description: "Model card JSON" },
]

const REQUIRED_CHAR_FILES: RequiredFile[] = [
	{ option: "model", remoteName: "model.onnx", description: "ONNX classifier (char_ids graph)" },
	{ option: "char-vocab", remoteName: "char-vocab.json", description: "sealed character vocabulary" },
	{ option: "model-card", remoteName: "model-card.json", description: "Model card JSON" },
]

function requiredFilesFor(args: PublishHFOptions): RequiredFile[] {
	return args.charVocab ? REQUIRED_CHAR_FILES : REQUIRED_FILES
}

const BUCKET_PATH = "hf://buckets/sister-software/mailwoman"

async function servedOnDemoPath(_name: string, _locale: string, _version: string): Promise<boolean> {
	return false
}

const BUCKET_RESOLVE = "https://huggingface.co/buckets/sister-software/mailwoman/resolve"

/**
 * Configures {@linkcode publishReleaseToHF} with the release identity
 * and the local paths of the artifacts to upload.
 *
 * The retired `wofHot` option is still accepted and is ignored.
 */
export interface PublishHFOptions {
	version?: string
	locale?: string
	label?: string
	description?: string
	model?: string
	tokenizer?: string

	/**
	 * Points to the sealed character vocabulary of a character-path model; when it is set,
	 * no tokenizer is required and the release gets no `releases.json` entry.
	 */
	charVocab?: string
	modelCard?: string
	fst?: string
	modelSize?: string
	steps?: number
	postcodes?: string
	pairIndexes?: string
	fsts?: string
	gazetteerLexicon?: string
	countryLexicon?: string
	streetTypeLexicon?: string
	localitySurfaceLexicon?: string
	polygons?: string
	fisher?: string
	setDefault?: boolean

	/**
	 * Is a retired option that is accepted and ignored so existing invocations do not fail.
	 */
	wofHot?: string
}

function fail(msg: string): never {
	throw new CommandError(msg)
}

const run = (cmd: string, args: string[]): void => runProcessOrFail(cmd, args)

const hfClient = new APIClient({ displayName: "publish-hf", retry: true })

async function checkRemoteFileExists(url: string) {
	try {
		await hfClient.fetch({ url, method: "head" })

		return true
	} catch {
		return false
	}
}

interface ReleaseManifest {
	releases: Array<Record<string, unknown>>
	defaultVersion?: string
}

async function stageBinaryList(spec: string | undefined, label: string): Promise<string[]> {
	const paths = extractDelimited(spec)

	for (const localPath of paths) {
		if (!(await pathExists(localPath)) || !(await statPath(localPath)).size) {
			fail(`${label} ${localPath} missing/empty`)
		}
	}

	return paths
}

async function stageOptionalBinary(spec: string | undefined, label: string): Promise<string | null> {
	const localPath = spec || null

	if (localPath && (!(await pathExists(localPath)) || !(await statPath(localPath)).size)) {
		fail(`${label} ${localPath} missing/empty`)
	}

	return localPath
}

function uploadFlatByBasename(paths: string[], remoteBase: string): void {
	for (const localPath of paths) {
		const remoteName = localPath.split("/").pop()
		const dst = `${BUCKET_PATH}/${remoteBase}/${remoteName}`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", localPath, dst])
	}
}

async function verifyFlatByBasename(paths: string[], remoteBase: string): Promise<void> {
	for (const localPath of paths) {
		const remoteName = localPath.split("/").pop()
		const url = `${BUCKET_RESOLVE}/${remoteBase}/${remoteName}`
		const ok = await checkRemoteFileExists(url)

		if (!ok) {
			fail(`${remoteName} unreachable at ${url}`)
		}

		console.error(`  ✓ ${url}`)
	}
}

async function verifyRequiredFiles(args: PublishHFOptions): Promise<void> {
	for (const f of requiredFilesFor(args)) {
		const localPath = args[OPTION_TO_FIELD[f.option]]

		if (!localPath) {
			fail(`--${f.option} (${f.description}) is required`)
		}

		if (!(await pathExists(localPath))) {
			fail(`${localPath} does not exist`)
		}

		const size = (await statPath(localPath)).size

		if (size === 0) {
			fail(`${localPath} is empty`)
		}

		console.error(`  ✓ ${f.remoteName}: ${localPath} (${ByteFormatter.formatIEC(size)})`)
	}
}

/**
 * Refuses to publish a model whose card records no training attribution,
 * and prints any recorded source that names no licence.
 *
 * Only a missing attribution list is fatal, because a source without a named licence
 * is a gap to record rather than a finding against it.
 */
export async function verifyTrainingProvenance(cardPath: PathBuilderLike): Promise<void> {
	const card = await readLocalJSONFile<{ attribution?: unknown; training?: { data_attribution?: unknown } }>(cardPath)

	const entries = [card.training?.data_attribution, card.attribution]
		.filter((candidate): candidate is unknown[] => Array.isArray(candidate))
		.map((candidate) => candidate.filter((entry): entry is string => typeof entry === "string"))
		.find((candidate) => candidate.length)

	if (!entries) {
		fail(
			`${cardPath} records attribution at neither training.data_attribution nor attribution, so this upload would publish a model whose sources nothing states. ` +
				"Record the sources the run trained on in the card before publishing. " +
				"See docs/engineering/reference/artifact-rights-inventory.mdx."
		)
	}

	console.error(`  ✓ recorded training sources: ${entries.length} entries`)

	for (const entry of entries) {
		const parenthetical = /\(([^()]{1,120})\)/u.exec(entry)
		const inner = parenthetical?.[1]?.trim() ?? ""
		const namesLicense = /\d/u.test(inner) || /\b(?:CC0|CC-BY|CC|ODbL|OGL|MIT|Apache|Licence|License)\b/iu.test(inner)

		if (namesLicense) continue

		console.error(`  ! names no license: ${entry}`)
	}
}

/**
 * Uploads a model release and its optional artifacts to the Hugging Face bucket, checks that
 * each required file is reachable, and adds the release to the locale's `releases.json`.
 *
 * A character-encoder release (one with `charVocab`) is uploaded but not added to `releases.json`.
 */
export async function publishReleaseToHF(args: PublishHFOptions): Promise<void> {
	if (!args.version) {
		fail("version argument required (e.g. mailwoman release hf v5.9.0 …)")
	}

	if (!args.locale) {
		fail("--locale required (e.g. en-us)")
	}

	if (!args.label) {
		fail("--label required")
	}

	if (!args.description) {
		fail("--description required")
	}

	const bcp47 = args.locale
		.split("-")
		.map((part: string, i: number) => (i === 0 ? part.toLowerCase() : part.toUpperCase()))
		.join("-")

	const fstRemoteName = `fst-${bcp47}.bin`
	const fstPath = await stageOptionalBinary(args.fst, "FST gazetteer")

	console.error(`Publishing ${args.version} (${args.locale}) to HF Bucket...`)

	await verifyRequiredFiles(args)

	await verifyTrainingProvenance(args.modelCard!)

	const postcodeBins = await stageBinaryList(args.postcodes, "postcode binary")

	const pairIndexBins = await stageBinaryList(args.pairIndexes, "pair-index binary")

	const fstBins = await stageBinaryList(args.fsts, "FST binary")

	const gazetteerLexicon = await stageOptionalBinary(args.gazetteerLexicon, "gazetteer lexicon")

	const countryLexicon = await stageOptionalBinary(args.countryLexicon, "country lexicon")

	const streetTypeLexicon = await stageOptionalBinary(args.streetTypeLexicon, "street-type lexicon")
	const localitySurfaceLexicon = await stageOptionalBinary(args.localitySurfaceLexicon, "locality-surface lexicon")

	const polygonsDB = await stageOptionalBinary(args.polygons, "polygon DB")

	const fisherArtifacts = await stageBinaryList(args.fisher, "Fisher artifact")

	const remoteBase = `${args.locale}/${args.version}`

	for (const f of requiredFilesFor(args)) {
		const localPath = args[OPTION_TO_FIELD[f.option]]!
		const dst = `${BUCKET_PATH}/${remoteBase}/${f.remoteName}`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", localPath, dst])
	}

	uploadFlatByBasename(postcodeBins, remoteBase)
	uploadFlatByBasename(pairIndexBins, remoteBase)

	uploadFlatByBasename(fstBins, remoteBase)

	if (fstPath) {
		const dst = `${BUCKET_PATH}/${remoteBase}/${fstRemoteName}`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", fstPath, dst])
	}

	if (gazetteerLexicon) {
		const dst = `${BUCKET_PATH}/${remoteBase}/anchor-lexicon-v1.json`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", gazetteerLexicon, dst])
	}

	if (countryLexicon) {
		const dst = `${BUCKET_PATH}/${remoteBase}/country-surface-lexicon-v1.json`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", countryLexicon, dst])
	}

	if (streetTypeLexicon) {
		const dst = `${BUCKET_PATH}/${remoteBase}/street-type-lexicon-v3.json`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", streetTypeLexicon, dst])
	}

	if (localitySurfaceLexicon) {
		const dst = `${BUCKET_PATH}/${remoteBase}/${basename(localitySurfaceLexicon)}`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", localitySurfaceLexicon, dst])
	}

	if (polygonsDB) {
		const dst = `${BUCKET_PATH}/${remoteBase}/wof-polygons.db`

		console.error(`  → ${dst}`)

		run("hf", ["buckets", "cp", polygonsDB, dst])
	}

	uploadFlatByBasename(fisherArtifacts, remoteBase)

	const required = requiredFilesFor(args)

	console.error(`Verifying ${required.length} artifacts via HTTPS...`)

	for (const f of required) {
		const url = `${BUCKET_RESOLVE}/${remoteBase}/${f.remoteName}`
		const ok = await checkRemoteFileExists(url)

		if (!ok) {
			fail(`${f.remoteName} unreachable at ${url}`)
		}

		console.error(`  ✓ ${url}`)
	}

	if (fstPath) {
		const fstURL = `${BUCKET_RESOLVE}/${remoteBase}/${fstRemoteName}`
		const fstOK = await checkRemoteFileExists(fstURL)

		if (!fstOK) {
			fail(`${fstRemoteName} unreachable at ${fstURL}`)
		}

		console.error(`  ✓ ${fstURL}`)
	}

	await verifyFlatByBasename(fstBins, remoteBase)

	await verifyFlatByBasename(fisherArtifacts, remoteBase)

	if (args.charVocab) {
		console.error(`\n✓ ${args.version} (${args.locale}) staged as a character-path family — no releases.json entry.`)

		return
	}

	const releasesURL = `${BUCKET_RESOLVE}/${args.locale}/releases.json`
	const res = await hfClient.fetch<ReleaseManifest>({ url: releasesURL, validateStatus: () => true })

	if (!isSuccessStatus(res.status)) {
		fail(`failed to fetch ${releasesURL}`)
	}

	const releases = res.data

	const newEntry: Record<string, unknown> = {
		version: args.version,
		label: args.label,
		description: args.description,
		modelSize: args.modelSize ?? ByteFormatter.formatIEC((await statPath(args.model!)).size),
		tokenizerVocab: 48_000,
		steps: args.steps ?? 100_000,
		hasFST: !!fstPath,
		hasWOFDB: true,

		hasAnchor: postcodeBins.length > 0 || (await servedOnDemoPath("postcode-us.bin", args.locale, args.version)),
		hasPolygons: !!polygonsDB || (await servedOnDemoPath("wof-polygons.db", args.locale, args.version)),
	}

	for (const flag of ["hasAnchor", "hasPolygons"]) {
		if (!newEntry[flag]) {
			console.warn(
				`⚠ ${flag}=false for ${args.version} — if the artifact will be staged to R2 later, releases.json must be re-patched or the demo silently degrades (rectangles / anchor-off).`
			)
		}
	}

	releases.releases = [newEntry, ...releases.releases.filter((r) => r.version !== args.version)]

	if (args.setDefault) {
		releases.defaultVersion = args.version
	}

	const tmpReleases = tempRootPath(`releases-${args.locale}-${Date.now()}.json`)
	await writeLocalJSONFile(releases, tmpReleases)
	run("hf", ["buckets", "cp", tmpReleases, `${BUCKET_PATH}/${args.locale}/releases.json`])

	console.error(`  ✓ releases.json updated, defaultVersion=${releases.defaultVersion}`)

	console.error(`\n✓ ${args.version} (${args.locale}) published successfully.`)
	console.error(`  Demo: https://mailwoman.ai/demo/`)
}
