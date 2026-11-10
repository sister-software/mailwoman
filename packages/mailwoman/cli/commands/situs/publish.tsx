/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Publishes one US address-layer version to the public bucket and verifies every object it uploaded.
 */

import { allKeyed } from "@mailwoman/core/promises"
import { CommandError } from "@mailwoman/core/scripting/command"

import {
	type CommandSpec,
	CommandSummaryLines,
	CommandTaskResult,
	type CommandComponent,
	useCommandTask,
} from "#cli-kit"

/**
 * Declares the options of `mailwoman situs publish`.
 */
export const spec = {
	name: "publish",
	description: "Publish one US address-layer version to the public bucket, regions first and the manifest last",
	options: {
		"layer-version": { type: "string", description: "The layer version to publish, an ISO date such as 2026-11-10" },
		"dry-run": { type: "boolean", default: false, description: "List the objects without uploading or verifying" },
	},
} as const satisfies CommandSpec

/**
 * The attempts a batch gets before a connection-level failure is reported.
 */
const PUBLISH_ATTEMPTS = 3

/**
 * The error codes of a network that dropped, as opposed to a refusal from the bucket.
 */
const CONNECTION_ERRORS: ReadonlySet<string> = new Set([
	"ETIMEDOUT",
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ENETUNREACH",
])

/**
 * Uploads the regions the version built, then its manifest, and checks each object against the bucket.
 *
 * A version can keep regions an earlier version built.
 * Those files are already published under their own version's paths, so only the
 * regions whose files sit under this version are uploaded.
 *
 * The manifest goes last, after every region it names is verified, so a reader
 * never sees a version whose files are missing.
 */
const SitusPublish: CommandComponent<typeof spec> = ({ options }) => {
	const state = useCommandTask(async () => {
		const version = options.layerVersion

		if (!version || !/^\d{4}-\d{2}-\d{2}$/u.test(version)) {
			throw new CommandError("--layer-version is required, as an ISO date such as 2026-11-10")
		}

		const {
			dataRoot: { dataRootPath },
			readers: { readLocalJSONFile },
			stat: { pathExists },
			temporary: { temporaryDirectory },
			writers: { createSymbolicLink, makeDirectories },
			layout: { addressLayerManifestPath },
			publicBucket: { formatPublicBucketPublishResult, publishToPublicBucket, verifyPublicBucketUploads },
			pathTs: { dirname, resolvePath },
			sleep: { sleep },
		} = await allKeyed({
			dataRoot: import("@mailwoman/core/data-root"),
			readers: import("@mailwoman/core/fs/readers"),
			stat: import("@mailwoman/core/fs/readers/stat"),
			temporary: import("@mailwoman/core/fs/temporary"),
			writers: import("@mailwoman/core/fs/writers"),
			layout: import("@mailwoman/resolver-wof-sqlite/address/keys/layout"),
			publicBucket: import("@mailwoman/gazetteer/tools/publish/public-bucket"),
			pathTs: import("path-ts"),
			sleep: import("@mailwoman/core/utils/sleep"),
		})

		type Manifest = import("@mailwoman/resolver-wof-sqlite/address/keys/layout").AddressLayerCountryManifest

		const root = dataRootPath("db")
		const manifestPath = addressLayerManifestPath(root, "US", version)

		if (!(await pathExists(manifestPath))) throw new CommandError(`no manifest at ${manifestPath}`)

		const manifest = await readLocalJSONFile<Manifest>(manifestPath)
		const built = manifest.regions.filter((region) => region.lookup.path.split("/").includes(version))

		if (!built.length) throw new CommandError(`the ${version} manifest names no region built in ${version}`)

		const dryRun = options.dryRun
		const lines: string[] = []

		/**
		 * Links each path, relative to the layer root, into a fresh staging directory,
		 * then publishes and verifies it.
		 */
		const publishPaths = async (paths: readonly string[], skipUnchanged: boolean) => {
			await using staging = await temporaryDirectory("address-layer-publish-")

			for (const path of paths) {
				const link = staging.path(path)

				await makeDirectories(dirname(link))
				await createSymbolicLink(resolvePath(root, path), link)
			}

			// Every key is under a dated version, so a stored object of the same size is the file,
			// and a retry resumes after the objects already stored.
			// A network that drops for minutes exhausts the client's own retries,
			// so a connection-level failure retries the whole batch.
			let result: Awaited<ReturnType<typeof publishToPublicBucket>> | null = null

			for (let attempt = 1; !result; attempt++) {
				try {
					result = await publishToPublicBucket({
						src: staging.path(),
						dryRun,
						skipUnchanged,
						onObject: console.error,
					})
				} catch (error) {
					const code = (error as { code?: string }).code ?? ""

					if (attempt >= PUBLISH_ATTEMPTS || !CONNECTION_ERRORS.has(code)) throw error

					console.error(`  ${code} on attempt ${attempt} of ${PUBLISH_ATTEMPTS}; retrying in 30 s`)

					await sleep(30_000)
				}
			}

			lines.push(formatPublicBucketPublishResult(result, dryRun).trim())

			if (dryRun) return

			const verified = await verifyPublicBucketUploads({ src: staging.path() })

			if (verified.mismatches.length) {
				throw new CommandError(
					`${verified.mismatches.length} of ${verified.objects} objects do not match the bucket:\n` +
						verified.mismatches.map(({ key, reason }) => `  ${key}: ${reason}`).join("\n")
				)
			}

			lines.push(`verified ${verified.objects} objects against the bucket's records`)
		}

		const regionPaths: string[] = []

		for (const region of built) {
			regionPaths.push(region.lookup.path, region.detail.path)

			const attribution = `${dirname(region.lookup.path)}/ATTRIBUTION.json`

			if (await pathExists(resolvePath(root, attribution))) {
				regionPaths.push(attribution)
			}
		}

		lines.push(`${version}: ${built.length} regions built in this version: ${built.map((r) => r.region).join(", ")}`)

		await publishPaths(regionPaths, true)
		// A manifest rewritten with one more region can keep its size, so it is always sent.
		await publishPaths([`addresses/us/${version}/manifest.json`], false)

		return lines
	})

	if (state.status !== "done") return <CommandTaskResult state={state} />

	return <CommandSummaryLines lines={state.result} />
}

export default SitusPublish
