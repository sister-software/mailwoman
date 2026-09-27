/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Publishes the browser demo's runtime assets to Cloudflare R2.
 *
 *   The staged directory mirrors the object layout below the configured prefix. Versioned objects receive a long,
 *   immutable cache lifetime. Mutable release manifests receive a short lifetime. Binary content types remain
 *   uncompressed so the browser can read database byte ranges.
 */

import { isDirectory, readFileSize } from "@mailwoman/core/fs/readers"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { CommandError } from "@mailwoman/core/scripting/command"
import { relative, type PathBuilderLike } from "path-ts"
import { Globerator } from "spliterator/node/fs"

/**
 * The one-week browser cache applied to objects whose key identifies an immutable version.
 */
export const IMMUTABLE_CACHE_CONTROL = "public, max-age=604800, immutable"

/**
 * The one-minute browser cache applied to release manifests that change at a stable key.
 */
export const MUTABLE_CACHE_CONTROL = "public, max-age=60, must-revalidate"

const MUTABLE_FILES = new Set(["releases.json"])
const VERSIONED_DIRECTORIES = new Set(["pair-index"])

/**
 * A versioned object path contains its directory, generation, and filename.
 */
const VERSIONED_PATH_SEGMENTS = 3

const CONTENT_TYPES = new Map([
	[".db", "application/octet-stream"],
	[".onnx", "application/octet-stream"],
	[".bin", "application/octet-stream"],
	[".model", "application/octet-stream"],
	[".json", "application/json"],
	[".js", "text/javascript"],
	[".wasm", "application/wasm"],
])

export interface DemoAssetUpload {
	file: string
	relativePath: string
	key: string
	size: number
	contentType: string
	cacheControl: string
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

function metadataFor(relativePath: string): Pick<DemoAssetUpload, "contentType" | "cacheControl"> {
	const filename = relativePath.split("/").at(-1) ?? relativePath

	return {
		contentType: CONTENT_TYPES.get(extension(relativePath)) ?? "application/octet-stream",
		cacheControl: MUTABLE_FILES.has(filename) ? MUTABLE_CACHE_CONTROL : IMMUTABLE_CACHE_CONTROL,
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

	const uploads = await Promise.all(
		files.map(async (file) => {
			const relativePath = relative(root, file).split("\\").join("/")
			const [directory] = relativePath.split("/")

			if (VERSIONED_DIRECTORIES.has(directory ?? "") && relativePath.split("/").length < VERSIONED_PATH_SEGMENTS) {
				throw new CommandError(
					"refusing to publish an un-versioned object under an immutable Cache-Control:\n" +
						`  ${relativePath}\n\n` +
						"This directory needs a generation segment: <dir>/<generation>/<file>, for example:\n" +
						"  pair-index/2026-08-05/pair-index-gb.bin\n" +
						"Overwriting a flat key leaves the CDN serving the old bytes for a week.\n" +
						"Bump PAIR_INDEX_VERSION in docs/src/shared/resources.tsx to match."
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
		await new Upload({
			client,
			params: {
				Bucket: bucket,
				Key: asset.key,
				Body: openReadStream(asset.file),
				ContentLength: asset.size,
				ContentType: asset.contentType,
				CacheControl: asset.cacheControl,
			},
		}).done()
	}
}

function objectLine(asset: DemoAssetUpload, dryRun: boolean): string {
	const sizeMiB = (asset.size / 1024 / 1024).toFixed(1)

	return `  ${dryRun ? "[dry-run]" : "✓"} ${asset.key}  (${asset.contentType}, ${asset.cacheControl}, ${sizeMiB} MB)`
}

/**
 * Publishes every file below `src` while preserving the demo's cache and range-request metadata.
 */
export async function publishDemoAssets(options: PublishDemoAssetsOptions): Promise<PublishDemoAssetsResult> {
	const bucket = options.bucket ?? "nexus-public"
	const prefix = options.prefix ?? "mailwoman"
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
