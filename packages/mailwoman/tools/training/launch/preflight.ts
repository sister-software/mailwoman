/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The launch preflight, run on the host against the copy of the volume under `MAILWOMAN_DATA_ROOT`.
 *
 *   It runs every audit the config declares through the audit commands under `tools/training/audits/`, on a copy of
 *   the config whose volume paths point at the host copy, checks the wall clock, and writes the receipt with
 *   `writePreflightReceipt`. The receipt's key binds the original YAML and the MANIFEST's file sha256 set, and the
 *   sandbox refuses a volume whose MANIFEST bytes differ from the host's, so the audits and the training read the same
 *   corpus.
 */

import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFile } from "@mailwoman/core/process"
import { readTrainingConfig, typedTrainingConfig } from "@mailwoman/corpus/training/config/load"
import type { TrainingConfig } from "@mailwoman/corpus/training/config/schema"

import { manifestFileDigests, writePreflightReceipt } from "#tools/training/audits/receipt"
import type { PreflightResult, ResolvedLaunchConfig } from "#tools/training/launch/launch"
import { rerootConfigText } from "#tools/training/launch/run-paths"
import { checkWallClock } from "#tools/training/launch/wall-clock"
import { volumePathOnHost } from "#tools/training/sampler"

/**
 * The audit identifiers a receipt records, spelled as the Python launcher's receipts spelled them.
 */
export const PreflightAudit = {
	CorpusFiles: "corpus_files",
	CorpusReceipts: "corpus_receipts",
	ValidationCoverage: "validation_coverage",
	ValidationLabelSupport: "validation_label_support",
	WallClock: "wall_clock",
} as const

export type PreflightAudit = (typeof PreflightAudit)[keyof typeof PreflightAudit]

/**
 * The audit command each declared audit runs, and how it takes the config.
 *
 * `script` is the command's path under `audits/`, and `report` the stem of the report file it writes.
 * The report stems are the names earlier receipts recorded.
 */
const AUDIT_COMMANDS: ReadonlyArray<{
	audit: PreflightAudit
	declared: (data: TrainingConfig["data"]) => boolean
	script: string
	report: string
	args: (config: string, json: string) => string[]
}> = [
	{
		audit: PreflightAudit.CorpusReceipts,
		declared: (data) => data.required_corpus_receipts.length > 0,
		script: "epoch/mixture.run.ts",
		report: "epoch-mixture",
		args: (config, json) => ["--config", config, "--json", json],
	},
	{
		audit: PreflightAudit.ValidationCoverage,
		declared: (data) => data.required_validation_coverage.length > 0,
		script: "validation/coverage.run.ts",
		report: "validation-coverage",
		args: (config, json) => [config, "--json", json],
	},
	{
		audit: PreflightAudit.ValidationLabelSupport,
		declared: (data) => data.required_validation_label_support.length > 0,
		script: "label/support.run.ts",
		report: "label-support",
		args: (config, json) => [config, "--json", json],
	},
]

/**
 * The audit scripts the preflight runs, as paths relative to `audits/`,
 * for the test that checks each exists.
 */
export const AUDIT_SCRIPTS = AUDIT_COMMANDS.map((command) => command.script)

export interface HostPreflightOptions {
	/**
	 * The YAML on the host.
	 */
	configPath: string
	mount: string
	dataRoot: string
	/**
	 * The sandbox timeout.
	 * The wall-clock estimate must fit within this limit.
	 */
	timeoutSeconds: number
	log: (line: string) => void
}

/**
 * Runs the preflight for `config` on `device` and writes the receipt under `<dataRoot>/audits`.
 *
 * @throws When the corpus MANIFEST is missing or lists no file, an audit command fails,
 * or the wall-clock estimate exceeds the sandbox timeout.
 */
export async function hostPreflight(
	config: ResolvedLaunchConfig,
	device: string,
	options: HostPreflightOptions
): Promise<PreflightResult> {
	const typed = typedTrainingConfig(await readTrainingConfig(options.configPath), options.configPath)
	const corpusDir = typed.data.corpus_dir
	const hostCorpus = volumePathOnHost(corpusDir)

	if (!hostCorpus)
		throw new Error(`the config's corpus_dir ${corpusDir} is not under the volume mount ${options.mount}`)

	const digests = await manifestFileDigests(hostCorpus)

	options.log(`Corpus: ${hostCorpus} (${digests.length} file digests in the MANIFEST)`)

	const auditRoot = `${options.dataRoot.replace(/\/+$/, "")}/audits`
	const stem = config.name.replace(/\.ya?ml$/, "")
	const reports: Record<string, string> = {}
	const audits: string[] = [PreflightAudit.CorpusFiles, PreflightAudit.WallClock]

	await using scratch = await temporaryDirectory("mailwoman-preflight-")
	const rerooted = scratch.path(config.name).toString()

	await writeLocalTextFile(
		rerootConfigText(await readLocalTextFile(options.configPath), options.mount, options.dataRoot),
		rerooted
	)

	for (const command of AUDIT_COMMANDS) {
		if (!command.declared(typed.data)) continue

		const json = `${auditRoot}/${command.report}-${stem}.json`
		const script = repoRootPath("packages", "mailwoman", "tools", "training", "audits", command.script).toString()

		await runFile(process.execPath, [script, ...command.args(rerooted, json)], { maxBuffer: 64 * 1024 * 1024 })
		reports[command.audit] = json
		audits.push(command.audit)
		options.log(`Audit ${command.audit}: passed (${json})`)
	}

	const estimate = checkWallClock(
		device,
		{ maxSteps: config.maxSteps, evalEverySteps: config.evalEverySteps, batchSize: config.batchSize },
		options.timeoutSeconds
	)

	options.log(
		`Wall clock on ${estimate.device}: ~${estimate.totalSeconds}s of the ${options.timeoutSeconds}s timeout ` +
			`(${estimate.trainSeconds}s of steps, ${estimate.evaluations} validation passes)`
	)

	const token = await writePreflightReceipt(auditRoot, options.configPath, hostCorpus, audits, reports)
	const manifestPath = `${corpusDir.replace(/\/+$/, "")}/MANIFEST.json`

	return {
		token,
		audits: audits.toSorted(),
		manifestPath,
		manifestSHA256: sha256Hex(await readLocalBuffer(`${hostCorpus}/MANIFEST.json`)),
	}
}
