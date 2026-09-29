/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Corpus data must be uploaded to R2 before GPU containers can use it.
 * Container-side sync then pulls from R2.
 */

import { dataRootPath } from "@mailwoman/core/data-root"
import { pathExists } from "@mailwoman/core/fs/readers"
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
 * Retry counts for every transfer here, above rclone's defaults of 10 low-level and 3 high-level.
 *
 * R2 returns an intermittent 501 that succeeds on a retry, and `push_artifact` in
 * `corpus-python/launch/artifacts.py` already rides it with these two values.
 * At the defaults a single 501 ends the job, and a 74 GiB corpus over a mobile link meets enough
 * of them to matter: one lost transfer costs the whole remaining file rather than the request.
 *
 * `rclone sync` compares size and modification time, so a re-run after any failure skips
 * the files that landed and re-sends only a file it was mid-way through.
 */
const R2_RETRIES = ["--low-level-retries", "30", "--retries", "8"]

/**
 * CLI command definition used by the filesystem router.
 */
export const spec = {
	name: "upload",
	description: "Upload a corpus version, tokenizer, or training code to R2",
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
		code: { type: "boolean", default: false, description: "Also sync corpus-python (the training code)" },
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
 * Fields this command reads from a version's top-level `MANIFEST.json`.
 *
 * Derived from `BuildCorpusManifest` to keep names in sync with the build output.
 * Optional so older manifests still parse.
 */
type UploadedCorpusManifest = Partial<
	Pick<BuildCorpusManifest, "licenses" | "license_policy" | "licenses_cover" | "total_aligned_rows">
>

/**
 * The row count the corpus's own manifest reports, which `overlay-manifest` rewrites on each merge.
 *
 * `total_rows` here counts the same labeled rows as the build manifest's `total_aligned_rows`,
 * so the two are comparable and their difference is what the overlays added.
 */
interface AssembledCorpusManifest {
	total_rows?: number
}

/**
 * The assembled corpus manifest's `total_rows`, or `undefined` when no manifest sits at `path`.
 *
 * A build that wrote no corpus manifest, and a flat-layout entry that holds none, both read
 * `undefined`, and {@linkcode refuseShareAlike} then leaves the overlay comparison unmade
 * rather than reading a missing file as a corpus with no overlay rows.
 */
async function assembledRowCount(path: PathBuilderLike): Promise<number | undefined> {
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")

	try {
		return (await readLocalJSONFile<AssembledCorpusManifest>(path)).total_rows
	} catch {
		return undefined
	}
}

/**
 * Throws when a corpus version's own license set carries or mentions share-alike.
 *
 * The decision reads the obligations recorded for each license value the corpus stores,
 * through `shareAlikeFindings`.
 * It does not read source ids, adapter names or license-string prefixes,
 * because a row's obligation is a property of its license value and a share-alike
 * register can reach a corpus through a source whose id says otherwise.
 *
 * An unreadable or absent `MANIFEST.json` throws as well.
 * A corpus whose license set cannot be read is an unanswered question rather than a clean one.
 *
 * `corpusRows` is the assembled corpus manifest's own `total_rows`, or `undefined`
 * when the upload found no nested corpus directory to read one from.
 * It decides whether the license set answers for every row.
 */
async function refuseShareAlike(
	version: string,
	manifestPath: PathBuilderLike,
	allow: boolean,
	corpusRows: number | undefined
): Promise<void> {
	const { readLocalJSONFile } = await import("@mailwoman/core/fs/readers")
	const { stringifyJSON } = await import("@mailwoman/core/json")
	const { shareAlikeFindings } = await import("@mailwoman/corpus/utils/license")

	let manifest: UploadedCorpusManifest

	try {
		manifest = await readLocalJSONFile<UploadedCorpusManifest>(manifestPath)
	} catch (error) {
		throw new Error(
			`corpus ${version}: ${manifestPath} could not be read (${(error as Error).message}), so its license ` +
				`set is unknown. Build the version through \`mw corpus build\`, which writes it, or pass ` +
				`--allow-share-alike to upload without the check.`
		)
	}

	if (!manifest.licenses) {
		throw new Error(
			`corpus ${version}: ${manifestPath} records no \`licenses\` map, so its license set is unknown. ` +
				`Pass --allow-share-alike to upload without the check.`
		)
	}

	// `align` increments the `licenses` map once per canonical adapter row, and `total_aligned_rows`
	// counts the labeled rows those fan out to, so the two are different units and cannot be compared.
	// The rows the map does not answer for are the ones `overlay-manifest` merged
	// after the build: they raise the corpus manifest's `total_rows` above the build
	// manifest's `total_aligned_rows` and carry their own license values.
	// A clean reading over the base alone would state that the whole corpus is free
	// of an obligation this check never looked for.
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

	const findings = shareAlikeFindings(manifest.licenses)

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
		const { $ } = await import("zx")

		const corpusRoot = PathBuilder.from(options.corpusDir ?? dataRootPath("corpus", "versioned"))

		const directories = extractDelimited(options.corpusDirectory)

		if (!directories.length && !options.tokenizer && !options.code) {
			const available = (await pathExists(corpusRoot))
				? (await Globerator.from("*", { cwd: corpusRoot, absolute: false }).toSorted()).slice(-6)
				: []

			throw new Error(
				"nothing selected. Pass --corpus-directory <name> (and/or --tokenizer, --code).\n" +
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
			// `corpus()` in `corpus-python/launch/plan.py` composes `corpus-<entry>` from the same string,
			// and its `NESTED` layout reads this directory out of the R2 key this job writes.
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

			// The layout decides which `Copy` row in `launch/corpora.py` stages the result,
			// so the reader has to see which one this transfer wrote rather than infer it from the key.
			process.stderr.write(`corpus ${directory}: ${layout} layout, uploading ${source}\n`)

			await refuseShareAlike(
				directory,
				corpusRoot(directory, "MANIFEST.json"),
				options.allowShareAlike,
				await assembledRowCount(PathBuilder.from(source)("MANIFEST.json"))
			)

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

		if (options.code) {
			jobs.push({
				label: "training code",
				source: "./corpus-python/",
				dest: `${base}/corpus-python/`,
				extra: ["--exclude", ".venv/**", "--exclude", "__pycache__/**", "--exclude", "*.egg-info/**"],
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
				await $({
					env,
				})`rclone sync ${job.source.toString()} ${job.dest} ${job.extra} ${dry} ${R2_RETRIES} --stats-one-line`.quiet()

				update(index, { status: "done", detail: options.dryRun ? "would sync" : "synced" })
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
