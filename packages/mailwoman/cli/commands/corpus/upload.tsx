/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Corpus data must be uploaded to R2 before GPU containers can use it.
 * Container-side sync then pulls from R2.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers/stat"
import { runProcess } from "@mailwoman/core/process"
import { extractDelimited } from "@mailwoman/core/scripting/arguments"
import { childEnv } from "@mailwoman/core/scripting/utils"
import type { BuildCorpusManifest } from "@mailwoman/corpus/build"
import { Box, Text } from "ink"
import { PathBuilder, type PathBuilderLike } from "path-ts"
import { useState } from "react"
import { Globerator } from "spliterator/node/fs"

import { isCorpusDirectory, type CommandSpec, CommandTaskResult, type CommandComponent, useCommandTask } from "#cli-kit"
import { $private } from "#env"

const DEFAULT_BUCKET = "mailwoman-assets"

/**
 * Transfer flags for every R2 job here.
 *
 * The bucket is versioned, so R2 answers each upload's `PUT` with an
 * `X-Amz-Version-Id`. rclone then confirms the object with `HEAD <key>?versionId=<id>`,
 * which R2 answers with 501 Not Implemented every time, so every file fails
 * although its bytes landed (observed 2026-10-21 with `--dump headers`).
 * `--s3-no-head` skips that request, and {@linkcode R2_SIZE_CHECK} confirms the transfer afterwards.
 *
 * R2 also answers rclone's pre-write bucket check with `NotImplemented`, failing every write.
 * `--s3-no-check-bucket` skips it, so the transfer does not depend on `.env`
 * setting `RCLONE_S3_NO_CHECK_BUCKET`.
 *
 * The retry counts stay above rclone's defaults of 10 low-level and 3 high-level
 * for transient failures on a long transfer.
 *
 * `rclone sync` compares size and modification time, so a re-run after any failure skips
 * the files that landed and re-sends only a file it was mid-way through.
 */
const R2_TRANSFER_FLAGS = ["--s3-no-head", "--s3-no-check-bucket", "--low-level-retries", "30", "--retries", "8"]

/**
 * The comparison that replaces rclone's skipped post-upload `HEAD`: every local
 * file exists in the destination with the same size.
 */
const R2_SIZE_CHECK = ["--size-only", "--one-way"]

/**
 * CLI command definition used by the filesystem router.
 */
export const spec = {
	name: "upload",
	description: "Upload a corpus version or tokenizer to R2",
	options: {
		bucket: { type: "string", default: DEFAULT_BUCKET, description: "R2 bucket name" },
		"corpus-directory": {
			type: "string",
			validate: isCorpusDirectory,
			validationMessage:
				"--corpus-directory is the entry name under <data-root>/corpus/versioned, which for a versioned " +
				"corpus carries a leading `v`, as `v0.7.0-de-holdout`. It is not the corpus version the build " +
				"takes, and it is not the `corpus-…` directory nested inside the entry.",
			description: "Entry name under <data-root>/corpus/versioned, and the R2 key prefix (repeatable, comma-separated)",
		},
		"corpus-dir": { type: "string", description: "Local corpus root. Default <data-root>/corpus/versioned" },
		tokenizer: { type: "boolean", default: false, description: "Also sync the tokenizer" },
		"dry-run": { type: "boolean", default: false, description: "Report the plan and transfer nothing" },
		"allow-share-alike": {
			type: "boolean",
			default: false,
			description:
				"Upload a corpus version whose license set carries or mentions share-alike. " +
				"Without it the upload refuses and reports the values and row counts it read",
		},
	},
} as const satisfies CommandSpec

/**
 * Fields this command reads from a version's `MANIFEST.json` files.
 *
 * Derived from `BuildCorpusManifest` to keep names in sync with the build output.
 * Optional so older manifests still parse.
 *
 * `total_rows` is the assembled corpus manifest's row count.
 * `overlay-manifest` rewrites it on each merge.
 *
 * It counts the same labeled rows as the build manifest's `total_aligned_rows`,
 * so the two are comparable and their difference is what the corpus overlays added.
 */
type UploadedCorpusManifest = Partial<
	Pick<BuildCorpusManifest, "licenses" | "license_policy" | "licenses_cover" | "total_aligned_rows">
> & { total_rows?: number }

/**
 * Which on-disk layout a `--corpus-directory` entry holds, and the directory the upload sends.
 *
 * A nested entry is `<root>/<entry>/corpus-<entry>/`, whose own `MANIFEST.json`
 * is the assembled corpus manifest.
 * A build output also writes the build manifest at `<root>/<entry>/MANIFEST.json`;
 * an overlay corpus assembled by `overlay-manifest` has none.
 *
 * A flat entry is `<root>/<entry>/` and its `MANIFEST.json` sits at the root of what is sent.
 */
export interface CorpusUploadSource {
	layout: "nested" | "flat"
	entry: PathBuilderLike
	source: PathBuilderLike
}

/**
 * Read one manifest the share-alike check needs, or throw naming the path.
 *
 * `--allow-share-alike` does not reach this: the flag accepts a known share-alike set
 * or an unrecorded one, and a manifest that cannot be read is neither.
 */
async function readRequiredManifest(version: string, path: PathBuilderLike): Promise<UploadedCorpusManifest> {
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	try {
		return await readLocalJSONFile<UploadedCorpusManifest>(path)
	} catch (error) {
		throw new Error(
			`corpus ${version}: ${path} could not be read (${(error as Error).message}), so the license set of ` +
				`what this upload sends is unknown. --allow-share-alike does not cover an unreadable manifest.`
		)
	}
}

/**
 * Throws when a corpus version's own license set includes or mentions share-alike.
 *
 * The decision reads the obligations recorded for each license value the corpus stores,
 * through `shareAlikeFindings`.
 * It does not read source ids, adapter names or license-string prefixes, because a
 * row's obligation is a property of its license value and a share-alike register can
 * reach a corpus through a source whose id identifies a different license.
 *
 * The manifest at the root of the uploaded directory must be readable.
 * An unreadable one throws even when `allow` is set.
 *
 * For a nested entry the build manifest beside it is read when present,
 * and throws when present but unreadable.
 *
 * The license set comes from whichever of the two records a `licenses` map, the uploaded one first.
 * When neither does, the set is unrecorded and refuses unless `allow` is set.
 */
export async function refuseShareAlike(version: string, upload: CorpusUploadSource, allow: boolean): Promise<void> {
	const { stringifyJSON } = await import("@mailwoman/core/json")
	const { shareAlikeFindings } = await import("@mailwoman/corpus/utils/license")

	const uploadedPath = PathBuilder.from(upload.source)("MANIFEST.json")
	const uploaded = await readRequiredManifest(version, uploadedPath)
	const buildPath = PathBuilder.from(upload.entry)("MANIFEST.json")

	const build =
		upload.layout === "nested" && (await pathExists(buildPath)) ? await readRequiredManifest(version, buildPath) : null

	const recorded = uploaded.licenses ? uploaded : build?.licenses ? build : null
	const corpusRows = uploaded.total_rows ?? null

	if (!recorded?.licenses) {
		const read = build ? `${uploadedPath} and ${buildPath}` : `${uploadedPath}`

		const detail =
			`corpus ${version}: ${read} record no \`licenses\` map, so the license set of this ${upload.layout}-layout ` +
			`upload is unrecorded.`

		if (!allow) throw new Error(`${detail} Pass --allow-share-alike to upload without the check.`)

		process.stderr.write(`${detail}\nProceeding under --allow-share-alike.\n`)

		return
	}

	const manifest = recorded
	const licenses = recorded.licenses

	// `align` increments the `licenses` map once per canonical adapter row.
	// `total_aligned_rows` counts the labeled rows produced from those rows.
	// The values use different units.
	// The rows the map does not answer for are the ones `overlay-manifest` merged
	// after the build: they raise the corpus manifest's `total_rows` above the build
	// manifest's `total_aligned_rows` and include their own license values.
	// A reading of the base by itself would state that the whole corpus is free of
	// an obligation this check never looked for.
	const aligned = manifest.total_aligned_rows ?? 0
	const held = corpusRows ?? 0

	if (aligned > 0 && held > aligned) {
		const overlaid = held - aligned

		const detail =
			`corpus ${version}: the \`licenses\` map answers for the ${aligned.toLocaleString()} rows this build ` +
			`aligned, and the corpus holds ${held.toLocaleString()}, so ${overlaid.toLocaleString()} rows were ` +
			`merged by \`overlay-manifest\` afterwards and carry license values this check cannot read. ` +
			`\`licenses_cover\` reads ` +
			`${stringifyJSON(manifest.licenses_cover ?? "nothing, because the corpus predates the field")}.`

		if (!allow) {
			throw new Error(
				`${detail}\nRun \`corpus overlay-manifest\` on a build that records the merged license set, or pass ` +
					`--allow-share-alike to upload with the gap recorded rather than measured.`
			)
		}

		process.stderr.write(`${detail}\nProceeding under --allow-share-alike.\n`)
	}

	const findings = shareAlikeFindings(licenses)

	if (!findings.length) return

	const rows = findings.reduce((total, finding) => total + finding.rows, 0)
	const lines = findings.map((finding) => `  ${finding.kind}  ${finding.rows} rows  ${finding.license}`)

	if (allow) {
		process.stderr.write(
			`corpus ${version}: uploading ${rows} rows under --allow-share-alike across ` +
				`${findings.length} license value(s):\n${lines.join("\n")}\n`
		)

		return
	}

	throw new Error(
		`corpus ${version}: its license set holds ${findings.length} value(s) carrying or mentioning ` +
			`share-alike over ${rows} rows. The build ran under license policy ` +
			`${manifest.license_policy ?? "unstated"}:\n${lines.join("\n")}\n` +
			`Rebuild with \`mw corpus build --license-policy share-alike-free\`, or pass --allow-share-alike ` +
			`to upload this set deliberately.`
	)
}

interface Step {
	label: string
	status: "pending" | "running" | "done" | "error" | "skipped"
	detail?: string
}

const MARK: Record<Step["status"], string> = {
	pending: "○",
	running: "◼",
	done: "✓",
	error: "✗",
	skipped: "–",
}

const CorpusUpload: CommandComponent<typeof spec> = ({ options }) => {
	const [steps, setSteps] = useState<Step[]>([])

	const state = useCommandTask(async () => {
		const corpusRoot = PathBuilder.from(options.corpusDir ?? dataRootPath("corpus", "versioned"))

		const directories = extractDelimited(options.corpusDirectory)

		if (!directories.length && !options.tokenizer) {
			const available = (await pathExists(corpusRoot))
				? (await Globerator.from("*", { cwd: corpusRoot, absolute: false }).toSorted()).slice(-6)
				: []

			throw new Error(
				"nothing selected. Pass --corpus-directory <name> (and/or --tokenizer).\n" +
					`Recent entries under ${corpusRoot}:\n  ${available.join("\n  ")}`
			)
		}

		// rclone uses `:s3:` credentials from env vars.
		// Empty `RCLONE_CONFIG` avoids noisy missing-config output.
		const env = childEnv({
			RCLONE_CONFIG: "",
			RCLONE_S3_PROVIDER: "Cloudflare",
			RCLONE_S3_ENDPOINT: $private.RCLONE_S3_ENDPOINT ?? "",
			RCLONE_S3_ACCESS_KEY_ID: $private.RCLONE_S3_ACCESS_KEY_ID ?? "",
			RCLONE_S3_SECRET_ACCESS_KEY: $private.RCLONE_S3_SECRET_ACCESS_KEY ?? "",
		})

		if (!env["RCLONE_S3_ENDPOINT"] || !env["RCLONE_S3_ACCESS_KEY_ID"]) {
			throw new Error(
				"RCLONE_S3_ENDPOINT / RCLONE_S3_ACCESS_KEY_ID absent from the private env. These are the " +
					"credentials, not an rclone.conf — a missing config file is normal for the `:s3:` form."
			)
		}

		const base = `:s3:${options.bucket}`
		const dry = options.dryRun ? ["--dry-run"] : []

		interface Job {
			label: string
			source: PathBuilderLike
			dest: string
			extra: string[]
		}

		const jobs: Job[] = []

		for (const directory of directories) {
			// The on-disk layout nests the corpus under its own name: <root>/<entry>/corpus-<entry>/.
			// `SYNC_SCRIPT` in `tools/training/launch/sync.ts` reads either layout
			// from the R2 key written by this job.
			const nested = corpusRoot(directory, `corpus-${directory}`)
			const layout = (await pathExists(nested)) ? "nested" : "flat"
			const source = layout === "nested" ? nested : corpusRoot(directory)

			if (!(await pathExists(source))) {
				throw new Error(
					`corpus ${directory}: neither ${nested} nor ${corpusRoot(directory)} is on disk. ` +
						`--corpus-directory takes the entry name under ${corpusRoot}, which for a versioned corpus ` +
						`carries a leading "v" as "v0.7.0-de-holdout".`
				)
			}

			// The layout decides how the launcher's sync stages the result, so the reader has to see
			// which one this transfer wrote rather than infer it from the key.
			process.stderr.write(`corpus ${directory}: ${layout} layout, uploading ${source}\n`)

			await refuseShareAlike(directory, { layout, entry: corpusRoot(directory), source }, options.allowShareAlike)

			jobs.push({
				label: `corpus ${directory}`,
				source,
				dest: `${base}/corpus/${directory}/`,
				extra: ["--transfers", "8", "--checkers", "16"],
			})
		}

		if (options.tokenizer) {
			jobs.push({
				label: "tokenizer",
				source: dataRootPath("models", "tokenizer"),
				dest: `${base}/models/tokenizer/`,
				extra: ["--transfers", "4"],
			})
		}

		setSteps(jobs.map((j) => ({ label: j.label, status: "pending" as const })))

		const update = (index: number, patch: Partial<Step>) =>
			setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))

		for (const [index, job] of jobs.entries()) {
			// Handle missing local sources here for clearer errors than rclone's output.
			if (!(await pathExists(job.source))) {
				update(index, { status: "error", detail: `not found locally: ${job.source}` })

				continue
			}

			update(index, { status: "running" })

			try {
				await runProcess(
					"rclone",
					["sync", job.source.toString(), job.dest, ...job.extra, ...dry, ...R2_TRANSFER_FLAGS, "--stats-one-line"],
					{ env }
				)

				if (!options.dryRun) {
					await runProcess("rclone", ["check", job.source.toString(), job.dest, ...job.extra, ...R2_SIZE_CHECK], {
						env,
					})
				}

				update(index, { status: "done", detail: options.dryRun ? "would sync" : "synced and size-checked" })
			} catch (error: unknown) {
				const e = error as Record<string, unknown>

				update(index, { status: "error", detail: String(e["stderr"] ?? e["message"] ?? error).slice(0, 160) })
			}
		}
	})

	// For setup/selection failures, show only the command error output.
	if (state.status === "error") return <CommandTaskResult state={state} />

	return (
		<Box flexDirection="column">
			<Text bold>corpus upload → R2 ({options.bucket})</Text>
			{options.dryRun ? <Text color="yellow">DRY RUN — nothing is transferred</Text> : null}
			<Text> </Text>
			{steps.map((step) => (
				<Text key={step.label}>
					{MARK[step.status]} {step.label}
					{step.detail ? ` — ${step.detail}` : ""}
				</Text>
			))}
		</Box>
	)
}

export default CorpusUpload
