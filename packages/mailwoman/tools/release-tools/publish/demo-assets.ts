/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Publishes the browser demo's runtime assets to Cloudflare R2.
 *
 *   The staged directory mirrors the object layout below the configured prefix. Versioned objects receive a long,
 *   immutable cache lifetime. Mutable release manifests receive a short lifetime. A `.bin` or `.onnx` object is fetched whole, so
 *   it is stored gzip-compressed with `Content-Encoding: gzip` and the browser decodes it transparently. Every other
 *   binary stays identity-encoded, because a byte-range read of an encoded object returns encoded bytes.
 */

import { gzip } from "@mailwoman/core/fs/compression"
import { readLocalBuffer } from "@mailwoman/core/fs/readers"
import { isDirectory, readFileSize } from "@mailwoman/core/fs/readers/stat"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
import { CommandError } from "@mailwoman/core/scripting/command"
import { relative, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

import { $public } from "#env"

/**
 * The one-week browser cache applied to objects whose key identifies an immutable version.
 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=604800, immutable"

/**
 * The one-minute browser cache applied to release manifests that change at a stable key.
 */
export const MUTABLE_CACHE_CONTROL = "public, max-age=60, must-revalidate"

const MUTABLE_FILES = new Set(["releases.json"])
const VERSIONED_DIRECTORIES = new Set(["pair-index", "autocomplete"])

/**
 * A versioned object path contains its directory, generation and filename.
 */
const VERSIONED_PATH_SEGMENTS = 3

const CONTENT_TYPES = new Map([
	[".db", "application/octet-stream"],
	[".onnx", "application/octet-stream"],
	[".bin", "application/octet-stream"],
	[".model", "application/octet-stream"],
	[".anct", "application/octet-stream"],
	[".json", "application/json"],
	[".js", "text/javascript"],
	[".wasm", "application/wasm"],
])

/**
 * Extensions whose objects are always fetched whole and are therefore stored gzip-encoded.
 *
 * A database (`.db`) and an embedding row file (`.rows`) are read by HTTP range and stay identity-encoded.
 * An autocomplete index file (`.anct`) is fetched whole by the page and compresses well.
 */
const WHOLE_FETCH_ENCODED_EXTENSIONS = new Set([".bin", ".onnx", ".anct"])

export interface DemoAssetUpload {
	file: string
	relativePath: string
	key: string
	/**
	 * The local file's size, before any content encoding.
	 */
	size: number
	contentType: string
	cacheControl: string
	/**
	 * The `Content-Encoding` recorded on the stored object, when the upload compresses it.
	 */
	contentEncoding: "gzip" | null
}

export type DemoAssetTransport = (upload: DemoAssetUpload, bucket: string) => Promise<void>

export interface DemoAssetEnvironment {
	RCLONE_S3_PUBLIC_ENDPOINT?: string
	RCLONE_S3_PUBLIC_ACCESS_KEY_ID?: string
	RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY?: string
	RCLONE_S3_PUBLIC_REGION?: string
}

export interface PublishDemoAssetsOptions {
	src: PathBuilderLike
	bucket?: string
	prefix?: string
	dryRun?: boolean
	env?: DemoAssetEnvironment
	upload?: DemoAssetTransport
	onObject?: (line: string) => void
}

export interface PublishDemoAssetsResult {
	bucket: string
	prefix: string
	objects: number
	bytes: number
}

function extension(path: string): string {
	const filename = path.split("/").at(-1) ?? path
	const dot = filename.lastIndexOf(".")

	return dot === -1 ? "" : filename.slice(dot).toLowerCase()
}

function metadataFor(relativePath: string): Pick<DemoAssetUpload, "contentType" | "cacheControl" | "contentEncoding"> {
	const filename = relativePath.split("/").at(-1) ?? relativePath
	const ext = extension(relativePath)

	return {
		contentType: CONTENT_TYPES.get(ext) ?? "application/octet-stream",
		cacheControl: MUTABLE_FILES.has(filename) ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
		contentEncoding: WHOLE_FETCH_ENCODED_EXTENSIONS.has(ext) ? "gzip" : null,
	}
}

/**
 * The directory whose dated generations hold the placetype-pair indexes.
 */
const PAIR_INDEX_DIRECTORY = "pair-index"

/**
 * The manifest beside one generation's binaries, listing the countries they cover.
 */
const PAIR_INDEX_MANIFEST = "index.json"

const PAIR_INDEX_BINARY = /^pair-index-([a-z]{2})\.bin$/

/**
 * One manifest {@linkcode writePairIndexManifests} wrote.
 */
export interface PairIndexManifestWrite {
	relativePath: string
	version: string
	countries: string[]
}

/**
 * Writes `index.json` beside each staged pair-index generation that holds a binary,
 * listing the countries those binaries cover in sorted order.
 *
 * The runtime reads the manifest to decide which binaries to request, so the list
 * is derived from the staged files rather than typed anywhere.
 * A generation directory without a binary is left as it is, so a manifest can
 * be staged and published on its own.
 */
export async function writePairIndexManifests(src: PathBuilderLike): Promise<PairIndexManifestWrite[]> {
	const root = src.toString()

	const binaries = await Globerator.from(`${PAIR_INDEX_DIRECTORY}/*/*.bin`, {
		cwd: root,
		absolute: true,
		onlyFiles: true,
	}).toSorted()

	const countriesByVersion = new Map<string, string[]>()

	for (const file of binaries) {
		const [, version, filename] = relative(root, file).split("\\").join("/").split("/")
		const match = filename ? PAIR_INDEX_BINARY.exec(filename) : null

		if (!version || !match) continue

		const countries = countriesByVersion.get(version) ?? []

		countries.push(match[1]!)
		countriesByVersion.set(version, countries)
	}

	const written: PairIndexManifestWrite[] = []

	for (const [version, unsorted] of countriesByVersion) {
		const countries = unsorted.toSorted()
		const relativePath = `${PAIR_INDEX_DIRECTORY}/${version}/${PAIR_INDEX_MANIFEST}`

		await writeLocalTextFile(prettyJSON({ version, countries }), `${root}/${relativePath}`)
		written.push({ relativePath, version, countries })
	}

	return written
}

/**
 * Refuses a staged pair-index generation that lacks its manifest.
 *
 * The runtime requests only the binaries the manifest lists, so a generation
 * published without one serves no pair index at all.
 */
function assertPairIndexManifests(relativePaths: readonly string[]): void {
	const generations = new Set<string>()

	for (const relativePath of relativePaths) {
		const [directory, version, filename] = relativePath.split("/")

		if (directory === PAIR_INDEX_DIRECTORY && version && filename) {
			generations.add(version)
		}
	}

	for (const version of generations) {
		const manifest = `${PAIR_INDEX_DIRECTORY}/${version}/${PAIR_INDEX_MANIFEST}`

		if (relativePaths.includes(manifest)) continue

		throw new CommandError(
			`refusing to publish ${PAIR_INDEX_DIRECTORY}/${version} without its ${PAIR_INDEX_MANIFEST}:\n` +
				"  the runtime reads that manifest to learn which countries the generation holds, and a generation\n" +
				"  without one serves no pair index. publishDemoAssets writes it from the staged binaries; a direct\n" +
				"  plan needs writePairIndexManifests(src) first."
		)
	}
}

/**
 * Lists and validates every object before any credentials are read or bytes are uploaded.
 */
export async function planDemoAssetUploads(src: PathBuilderLike, prefix = "mailwoman"): Promise<DemoAssetUpload[]> {
	const root = src.toString()

	if (!(await isDirectory(root))) throw new CommandError(`--src is not a directory: ${root}`)

	const files = await Globerator.from("**/*", { cwd: root, absolute: true, onlyFiles: true }).toSorted()

	if (!files.length) throw new CommandError(`no files under ${root}`)

	assertPairIndexManifests(files.map((file) => relative(root, file).split("\\").join("/")))

	const uploads = await Promise.all(
		files.map(async (file) => {
			const relativePath = relative(root, file).split("\\").join("/")
			const [directory] = relativePath.split("/")

			if (VERSIONED_DIRECTORIES.has(directory ?? "") && relativePath.split("/").length < VERSIONED_PATH_SEGMENTS) {
				throw new CommandError(
					"refusing to publish an un-versioned object under an immutable Cache-Control:\n" +
						`  ${relativePath}\n\n` +
						"This directory needs a generation segment: <dir>/<generation>/<file>, for example:\n" +
						"  pair-index/2026-10-17/pair-index-gb.bin\n" +
						"Overwriting a flat key leaves the CDN serving the old bytes for a week.\n" +
						"Bump PAIR_INDEX_VERSION in packages/mailwoman/lib/browser-runtime/resources.ts to match."
				)
			}

			return {
				file,
				relativePath,
				key: `${prefix}/${relativePath}`,
				size: await readFileSize(file),
				...metadataFor(relativePath),
			}
		})
	)

	return uploads
}

function requiredEnv(env: DemoAssetEnvironment, name: keyof DemoAssetEnvironment): string {
	const value = env[name]

	if (!value) throw new CommandError(`missing env var ${name} (source the repo .env first)`)

	return value
}

async function defaultEnvironment(): Promise<DemoAssetEnvironment> {
	const { $private } = await import("#env")

	return {
		RCLONE_S3_PUBLIC_ENDPOINT: $private.RCLONE_S3_PUBLIC_ENDPOINT,
		RCLONE_S3_PUBLIC_ACCESS_KEY_ID: $private.RCLONE_S3_PUBLIC_ACCESS_KEY_ID,
		RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY: $private.RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY,
		RCLONE_S3_PUBLIC_REGION: $private.RCLONE_S3_PUBLIC_REGION,
	}
}

async function awsTransport(env: DemoAssetEnvironment): Promise<DemoAssetTransport> {
	const [{ S3Client }, { Upload }] = await Promise.all([import("@aws-sdk/client-s3"), import("@aws-sdk/lib-storage")])

	const client = new S3Client({
		endpoint: requiredEnv(env, "RCLONE_S3_PUBLIC_ENDPOINT"),
		region: env["RCLONE_S3_PUBLIC_REGION"] ?? "auto",
		credentials: {
			accessKeyId: requiredEnv(env, "RCLONE_S3_PUBLIC_ACCESS_KEY_ID"),
			secretAccessKey: requiredEnv(env, "RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY"),
		},
	})

	return async (asset, bucket) => {
		const encoded = asset.contentEncoding ? await gzip(await readLocalBuffer(asset.file)) : null

		await new Upload({
			client,
			params: {
				Bucket: bucket,
				Key: asset.key,
				Body: encoded ?? openReadStream(asset.file),
				ContentLength: encoded?.byteLength ?? asset.size,
				ContentType: asset.contentType,
				CacheControl: asset.cacheControl,
				ContentEncoding: asset.contentEncoding ?? undefined,
			},
		}).done()
	}
}

function objectLine(asset: DemoAssetUpload, dryRun: boolean): string {
	const sizeMiB = (asset.size / 1024 / 1024).toFixed(1)

	const encoding = asset.contentEncoding ? `, ${asset.contentEncoding}` : ""

	return `  ${dryRun ? "[dry-run]" : "✓"} ${asset.key}  (${asset.contentType}${encoding}, ${asset.cacheControl}, ${sizeMiB} MB)`
}

/**
 * Publishes every file below `src` while preserving the demo's cache and range-request metadata.
 */
export async function publishDemoAssets(options: PublishDemoAssetsOptions): Promise<PublishDemoAssetsResult> {
	const bucket = options.bucket ?? $public.MAILWOMAN_PUBLIC_BUCKET
	const prefix = options.prefix ?? "mailwoman"

	// The manifests are derived from the staged binaries on every publish, so a staged
	// generation never reaches the bucket with a list that disagrees with its files.
	await writePairIndexManifests(options.src)

	const uploads = await planDemoAssetUploads(options.src, prefix)
	const dryRun = options.dryRun ?? false

	const transport = dryRun
		? undefined
		: (options.upload ?? (await awsTransport(options.env ?? (await defaultEnvironment()))))

	for (const asset of uploads) {
		await transport?.(asset, bucket)
		options.onObject?.(objectLine(asset, dryRun))
	}

	return {
		bucket,
		prefix,
		objects: uploads.length,
		bytes: uploads.reduce((total, asset) => total + asset.size, 0),
	}
}

/**
 * Formats the final report shared by the standalone entry point and tests.
 */
export function formatDemoAssetPublishResult(result: PublishDemoAssetsResult, dryRun: boolean): string {
	return (
		`\n${dryRun ? "(dry-run) " : ""}${result.objects} objects, ${(result.bytes / 1024 / 1024).toFixed(1)} MB → ` +
		`${result.bucket}/${result.prefix}/\nServed at https://public.mailwoman.ai/${result.prefix}/...`
	)
}
