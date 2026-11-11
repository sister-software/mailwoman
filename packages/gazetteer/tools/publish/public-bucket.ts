/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file Publishes the gazetteer's built artifacts and the browser runtime's assets to the public R2 bucket.
 *
 *   The staged directory mirrors the object layout below the configured prefix. Versioned objects receive a long,
 *   immutable cache lifetime. Mutable release manifests receive a short lifetime. A `.bin` or `.onnx` object is fetched whole, so
 *   it is stored gzip-compressed with `Content-Encoding: gzip` and the browser decodes it transparently. Every other
 *   binary stays identity-encoded, because a byte-range read of an encoded object returns encoded bytes.
 */

import { $public } from "@mailwoman/core/env"
import { gunzip, gzip } from "@mailwoman/core/fs/compression"
import { readFileRange, readLocalBuffer } from "@mailwoman/core/fs/readers"
import { isDirectory, readFileSize } from "@mailwoman/core/fs/readers/stat"
import { openReadStream } from "@mailwoman/core/fs/streams"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { prettyJSON } from "@mailwoman/core/json"
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

/**
 * Files rewritten at a stable key.
 *
 * An address-layer version's `manifest.json` is one: a build that adds a region
 * to the version rewrites its manifest.
 */
const MUTABLE_FILES = new Set(["releases.json", "manifest.json"])
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

export interface PublicBucketUpload {
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

export type PublicBucketTransport = (upload: PublicBucketUpload, bucket: string) => Promise<void>

export interface PublicBucketEnvironment {
	RCLONE_S3_PUBLIC_ENDPOINT?: string
	RCLONE_S3_PUBLIC_ACCESS_KEY_ID?: string
	RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY?: string
	RCLONE_S3_PUBLIC_REGION?: string
}

export interface PublishToPublicBucketOptions {
	src: PathBuilderLike
	bucket?: string
	prefix?: string
	dryRun?: boolean
	env?: PublicBucketEnvironment
	upload?: PublicBucketTransport
	onObject?: (line: string) => void
	/**
	 * Skip an identity-encoded object the bucket already stores at the local file's size,
	 * so an interrupted publish resumes after the objects it finished.
	 *
	 * An encoded object is always uploaded, since its stored size is the compressed one.
	 * Use it only for keys under a versioned path, where an object of the same size is the same file.
	 */
	skipUnchanged?: boolean
}

export interface PublishToPublicBucketResult {
	bucket: string
	prefix: string
	/**
	 * Every object the staged directory holds, and the local bytes they total.
	 */
	objects: number
	bytes: number
	/**
	 * The objects this run sent, and their local bytes.
	 * `skipUnchanged` leaves the rest already stored.
	 */
	uploaded: number
	uploadedBytes: number
}

function extension(path: string): string {
	const filename = path.split("/").at(-1) ?? path
	const dot = filename.lastIndexOf(".")

	return dot === -1 ? "" : filename.slice(dot).toLowerCase()
}

function metadataFor(
	relativePath: string
): Pick<PublicBucketUpload, "contentType" | "cacheControl" | "contentEncoding"> {
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
				"  without one serves no pair index. publishToPublicBucket writes it from the staged binaries; a direct\n" +
				"  plan needs writePairIndexManifests(src) first."
		)
	}
}

/**
 * The two bytes every gzip member starts with.
 */
const GZIP_SIGNATURE = [0x1f, 0x8b] as const

/**
 * Refuses a staged file that's already gzip data when the upload gzip-encodes its extension.
 *
 * The browser removes one encoding layer, so a twice-compressed object reaches its reader as gzip bytes.
 * A copy downloaded from the bucket without decoding is the usual source.
 */
async function assertNotPrecompressed(file: string, relativePath: string): Promise<void> {
	const head = await readFileRange(file, 0, GZIP_SIGNATURE.length)

	if (head[0] !== GZIP_SIGNATURE[0] || head[1] !== GZIP_SIGNATURE[1]) return

	throw new CommandError(
		`refusing to publish ${relativePath}: the staged file is already gzip data.\n` +
			"  The upload stores this extension gzip-encoded, and the browser removes one layer, so its reader\n" +
			"  would receive gzip bytes. Stage the decoded file: a copy fetched from the bucket needs\n" +
			"  `rclone copyto --s3-decompress` or a gunzip first."
	)
}

/**
 * Lists and validates every object before any credentials are read or bytes are uploaded.
 */
export async function planPublicBucketUploads(
	src: PathBuilderLike,
	prefix = "mailwoman"
): Promise<PublicBucketUpload[]> {
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

			const metadata = metadataFor(relativePath)

			if (metadata.contentEncoding === "gzip") {
				await assertNotPrecompressed(file, relativePath)
			}

			return {
				file,
				relativePath,
				key: `${prefix}/${relativePath}`,
				size: await readFileSize(file),
				...metadata,
			}
		})
	)

	return uploads
}

function requiredEnv(env: PublicBucketEnvironment, name: keyof PublicBucketEnvironment): string {
	const value = env[name]

	if (!value) throw new CommandError(`missing env var ${name} (source the repo .env first)`)

	return value
}

async function defaultEnvironment(): Promise<PublicBucketEnvironment> {
	const { $private } = await import("mailwoman/env")

	return {
		RCLONE_S3_PUBLIC_ENDPOINT: $private.RCLONE_S3_PUBLIC_ENDPOINT,
		RCLONE_S3_PUBLIC_ACCESS_KEY_ID: $private.RCLONE_S3_PUBLIC_ACCESS_KEY_ID,
		RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY: $private.RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY,
		RCLONE_S3_PUBLIC_REGION: $private.RCLONE_S3_PUBLIC_REGION,
	}
}

async function publicBucketClient(env: PublicBucketEnvironment) {
	const { S3Client } = await import("@aws-sdk/client-s3")

	return new S3Client({
		endpoint: requiredEnv(env, "RCLONE_S3_PUBLIC_ENDPOINT"),
		region: env["RCLONE_S3_PUBLIC_REGION"] ?? "auto",
		credentials: {
			accessKeyId: requiredEnv(env, "RCLONE_S3_PUBLIC_ACCESS_KEY_ID"),
			secretAccessKey: requiredEnv(env, "RCLONE_S3_PUBLIC_SECRET_ACCESS_KEY"),
		},
		// Without a request timeout, a connection that stops moving bytes holds its part forever.
		// The timeout fails the stalled part, and the retry sends it again.
		requestHandler: {
			requestTimeout: REQUEST_TIMEOUT_MS,
			throwOnRequestTimeout: true,
			// Kept-alive sockets let the parts of one object reuse connections instead of opening one each.
			// Node's address racing gives each candidate 250 ms by default, so a slow
			// link exhausts every address and fails with ETIMEDOUT.
			// A longer attempt window lets a slow IPv4 connect finish.
			httpsAgent: { keepAlive: true, autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS },
		},
		maxAttempts: 5,
	})
}

/**
 * How long one request may go without completing before it is failed and retried.
 *
 * A multipart part is {@linkcode UPLOAD_PART_BYTES}, which this host sent in about 6 s on 2026-11-09.
 */
const REQUEST_TIMEOUT_MS = 120_000

/**
 * How long a connect to one of the endpoint's addresses may take before the next is tried.
 *
 * The endpoint resolves to IPv4 and IPv6 addresses.
 * On 2026-11-09 the lab host connected over IPv4 in 0.5–1.9 s and had no IPv6 route.
 */
const CONNECT_ATTEMPT_MS = 2000

/**
 * The size of each multipart part.
 *
 * The library's 5 MiB default turns a 4 GiB database into some 800 requests.
 */
const UPLOAD_PART_BYTES = 32 * 1024 * 1024

/**
 * Parts of one object in flight at once.
 */
const UPLOAD_QUEUE_SIZE = 8

async function awsTransport(env: PublicBucketEnvironment): Promise<PublicBucketTransport> {
	const [client, { Upload }] = await Promise.all([publicBucketClient(env), import("@aws-sdk/lib-storage")])

	return async (asset, bucket) => {
		const encoded = asset.contentEncoding ? await gzip(await readLocalBuffer(asset.file)) : null

		await new Upload({
			client,
			partSize: UPLOAD_PART_BYTES,
			queueSize: UPLOAD_QUEUE_SIZE,
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

/**
 * One object the public bucket stores, by key and size.
 */
export interface PublicBucketObject {
	key: string
	bytes: number
}

/**
 * Lists every object the public bucket stores under a prefix, following continuation tokens to the end.
 */
export async function listPublicBucketObjects(
	options: { prefix?: string; bucket?: string; env?: PublicBucketEnvironment } = {}
): Promise<PublicBucketObject[]> {
	const env = options.env ?? (await defaultEnvironment())
	const bucket = options.bucket ?? $public.MAILWOMAN_PUBLIC_BUCKET
	const [client, { ListObjectsV2Command }] = await Promise.all([publicBucketClient(env), import("@aws-sdk/client-s3")])
	const objects: PublicBucketObject[] = []
	let token: string | undefined

	do {
		const page = await client.send(
			new ListObjectsV2Command({ Bucket: bucket, Prefix: options.prefix, ContinuationToken: token })
		)

		for (const object of page.Contents ?? []) {
			if (object.Key) {
				objects.push({ key: object.Key, bytes: object.Size ?? 0 })
			}
		}

		token = page.IsTruncated ? page.NextContinuationToken : undefined
	} while (token)

	return objects
}

/**
 * Returns a reader of an object's stored size, or null for a key the bucket doesn't hold.
 */
async function storedObjectSize(
	env: PublicBucketEnvironment
): Promise<(bucket: string, key: string) => Promise<number | null>> {
	const [client, { HeadObjectCommand }] = await Promise.all([publicBucketClient(env), import("@aws-sdk/client-s3")])

	return async (bucket, key) => {
		try {
			return (await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? null
		} catch (error) {
			if ((error as { name?: string }).name === "NotFound") return null

			throw error
		}
	}
}

function objectLine(asset: PublicBucketUpload, dryRun: boolean): string {
	const sizeMiB = (asset.size / 1024 / 1024).toFixed(1)

	const encoding = asset.contentEncoding ? `, ${asset.contentEncoding}` : ""

	return `  ${dryRun ? "[dry-run]" : "✓"} ${asset.key}  (${asset.contentType}${encoding}, ${asset.cacheControl}, ${sizeMiB} MB)`
}

/**
 * Publishes every file below `src` while preserving the demo's cache and range-request metadata.
 */
export async function publishToPublicBucket(
	options: PublishToPublicBucketOptions
): Promise<PublishToPublicBucketResult> {
	const bucket = options.bucket ?? $public.MAILWOMAN_PUBLIC_BUCKET
	const prefix = options.prefix ?? "mailwoman"

	// The manifests are derived from the staged binaries on every publish, so a staged
	// generation never reaches the bucket with a list that disagrees with its files.
	await writePairIndexManifests(options.src)

	const uploads = await planPublicBucketUploads(options.src, prefix)
	const dryRun = options.dryRun ?? false

	const env = dryRun ? null : (options.env ?? (await defaultEnvironment()))
	const transport = env ? (options.upload ?? (await awsTransport(env))) : undefined
	const stored = env && options.skipUnchanged ? await storedObjectSize(env) : null

	let uploaded = 0
	let uploadedBytes = 0

	for (const asset of uploads) {
		if (stored && !asset.contentEncoding && (await stored(bucket, asset.key)) === asset.size) {
			options.onObject?.(`  = ${asset.key}  (already stored at ${asset.size} bytes)`)

			continue
		}

		await transport?.(asset, bucket)
		options.onObject?.(objectLine(asset, dryRun))

		uploaded++
		uploadedBytes += asset.size
	}

	return {
		bucket,
		prefix,
		objects: uploads.length,
		bytes: uploads.reduce((total, asset) => total + asset.size, 0),
		uploaded,
		uploadedBytes,
	}
}

/**
 * One staged file whose stored object doesn't match it.
 */
export interface PublicBucketMismatch {
	key: string
	reason: string
}

/**
 * Checks every file below `src` against the object the bucket stores for it,
 * through the bucket's own records.
 *
 * A plain object's stored `ContentLength` must equal the file's size.
 * An object the publisher gzips is fetched, decompressed and compared byte for byte,
 * since its stored length is the compressed one.
 *
 * A missing object or a failed request is reported as a mismatch.
 *
 * The bucket's records are read with `HeadObject` rather than over the public URL: a one-byte range
 * request through Node's `fetch` came back `200` without `Content-Range` for large objects there.
 */
export async function verifyPublicBucketUploads(
	options: Pick<PublishToPublicBucketOptions, "src" | "bucket" | "prefix" | "env">
): Promise<{ objects: number; mismatches: PublicBucketMismatch[] }> {
	const bucket = options.bucket ?? $public.MAILWOMAN_PUBLIC_BUCKET
	const uploads = await planPublicBucketUploads(options.src, options.prefix ?? "mailwoman")

	const [client, { HeadObjectCommand, GetObjectCommand }] = await Promise.all([
		publicBucketClient(options.env ?? (await defaultEnvironment())),
		import("@aws-sdk/client-s3"),
	])

	const mismatches: PublicBucketMismatch[] = []

	for (const asset of uploads) {
		try {
			const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: asset.key }))

			if (!asset.contentEncoding) {
				if (head.ContentLength !== asset.size) {
					mismatches.push({ key: asset.key, reason: `stored ${head.ContentLength} bytes, local ${asset.size}` })
				}

				continue
			}

			const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: asset.key }))
			const stored = await gunzip(await object.Body!.transformToByteArray())
			const local = await readLocalBuffer(asset.file)

			if (stored.length !== local.length || !local.equals(stored)) {
				mismatches.push({ key: asset.key, reason: `decoded ${stored.length} bytes, local ${local.length}` })
			}
		} catch (error) {
			mismatches.push({ key: asset.key, reason: `${(error as Error).name}: ${(error as Error).message}` })
		}
	}

	return { objects: uploads.length, mismatches }
}

/**
 * Formats the final report shared by the standalone entry point and tests.
 */
export function formatPublicBucketPublishResult(result: PublishToPublicBucketResult, dryRun: boolean): string {
	const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
	const stored = result.objects - result.uploaded
	const storedText = stored ? `; ${stored} already stored` : ""

	return (
		`\n${dryRun ? "(dry-run) " : ""}${result.uploaded} of ${result.objects} objects sent, ` +
		`${megabytes(result.uploadedBytes)} MB${storedText} → ` +
		`${result.bucket}/${result.prefix}/\nServed at https://public.mailwoman.post/${result.prefix}/...`
	)
}
