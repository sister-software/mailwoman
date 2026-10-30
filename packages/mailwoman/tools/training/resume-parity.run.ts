/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Checks that a resumed Rust training run reproduces an uninterrupted one. It runs `trainer train` on a resolved
 *   config to the end, runs it again with the process killed after it logs `--kill-after`, resumes that run with
 *   `--resume auto`, and compares the two runs:
 *
 *   - every `train_log.csv` cell except `wall_seconds`, keeping the resumed log's last row per step and kind;
 *   - the realized rows the resumed attempt consumed against the same rows of the uninterrupted run, which are the
 *     batch identities;
 *   - the final checkpoints' `rng_state.safetensors` bytes.
 *
 *   The kill lands after the step `--kill-after` names, so the resume starts from the newest checkpoint before it, and
 *   `--batch-size` maps that checkpoint's step to a realized-row offset. It writes `compare.json` under `--out` and
 *   exits 1 when anything differs.
 *
 *   Usage:
 *     node packages/mailwoman/tools/training/resume-parity.run.ts --trainer <path to trainer> --config <resolved.json> \
 *       --out <directory> --kill-after 110 --resume-step 100 --batch-size 8 [--threads 4]
 */

import { unzstd } from "@mailwoman/core/fs/compression"
import { readLocalBuffer, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { sha256Hex } from "@mailwoman/core/hash"
import { runFile, spawnProcess } from "@mailwoman/core/process"
import { parseArguments } from "@mailwoman/core/scripting/arguments"
import { PathBuilder, resolvePath } from "path-ts"

const { values } = parseArguments({
	options: {
		trainer: { type: "string" },
		config: { type: "string" },
		out: { type: "string" },
		"kill-after": { type: "string" },
		"resume-step": { type: "string" },
		"batch-size": { type: "string" },
		threads: { type: "string", default: "4" },
	},
})

const required = (name: keyof typeof values) => {
	const value = values[name]

	if (typeof value !== "string" || !value) throw new Error(`--${name} is required`)

	return value
}

const out = PathBuilder.from(resolvePath(required("out")))
const killAfter = Number(required("kill-after"))
const resumeStep = Number(required("resume-step"))
const batchSize = Number(required("batch-size"))
const log: string[] = []

const trainArguments = (name: string, extra: string[] = []) => [
	"train",
	required("config"),
	"--set",
	`train.output_dir=${out.toString()}/${name}/checkpoints`,
	"--threads",
	values.threads!,
	...extra,
]

async function train(name: string, extra: string[] = []): Promise<void> {
	log.push(`$ trainer ${trainArguments(name, extra).join(" ")}`)

	const { stdout, stderr } = await runFile(required("trainer"), trainArguments(name, extra), { maxBuffer: 1 << 28 })

	log.push(stdout, stderr)
}

function trainUntilKilled(name: string): Promise<void> {
	log.push(`$ trainer ${trainArguments(name).join(" ")}  # killed after step ${killAfter}`)

	const child = spawnProcess(required("trainer"), trainArguments(name))
	let seen = ""

	child.stdout.on("data", (chunk: Buffer) => {
		seen += chunk.toString()

		const last = [...seen.matchAll(/^step (\d+)\//gmu)].at(-1)

		if (last && Number(last[1]) >= killAfter) {
			child.kill("SIGKILL")
		}
	})

	return new Promise((resolve) => {
		child.on("exit", (code, signal) => {
			log.push(seen, `exit ${code} signal ${signal}`)
			resolve()
		})
	})
}

type Row = Record<string, string>

async function readLog(name: string): Promise<{ columns: string[]; rows: Map<string, Row> }> {
	// oxlint-disable-next-line mailwoman/prefer-spliterator -- a 200-step log of a few dozen rows
	const [header, ...lines] = (await readLocalTextFile(out(name, "train_log.csv"))).trim().split("\n")
	const columns = header!.split(",")
	const rows = new Map<string, Row>()

	for (const line of lines) {
		const row = Object.fromEntries(line.split(",").map((cell, i) => [columns[i]!, cell])) as Row

		rows.set(`${row.step}:${row.val_loss ? "eval" : "train"}`, row)
	}

	return { columns, rows }
}

async function realizedLines(name: string, from: number): Promise<string[]> {
	const bytes = await readLocalBuffer(out(name, "checkpoints", `exposure-realized-from-${from}.rows.jsonl.zst`))

	// oxlint-disable-next-line mailwoman/prefer-spliterator -- one run's realized rows, compared line by line
	return new TextDecoder().decode(unzstd(bytes)).trim().split("\n")
}

await makeDirectories(out)
await train("uninterrupted")
await trainUntilKilled("resumed")
await train("resumed", ["--resume", "auto"])

const left = await readLog("uninterrupted")
const right = await readLog("resumed")
const differing: string[] = []
let cells = 0

for (const [key, row] of left.rows) {
	const other = right.rows.get(key)

	if (!other) {
		differing.push(`${key}: absent from the resumed log`)

		continue
	}

	for (const column of left.columns.filter((name) => name !== "wall_seconds")) {
		cells++

		if (row[column] !== other[column]) {
			differing.push(`${key} ${column}: ${row[column]} vs ${other[column]}`)
		}
	}
}

const expectedBatches = (await realizedLines("uninterrupted", 0)).slice(resumeStep * batchSize)
const resumedBatches = await realizedLines("resumed", resumeStep)
const batchDifferences = expectedBatches.filter((line, i) => line !== resumedBatches[i]).length
const finalStep = String(Math.max(...[...left.rows.values()].map((row) => Number(row.step)))).padStart(6, "0")

const rngState = async (name: string) =>
	sha256Hex(await readLocalBuffer(out(name, "checkpoints", `step-${finalStep}`, "rng_state.safetensors")))

const rng = { uninterrupted: await rngState("uninterrupted"), resumed: await rngState("resumed") }

const report = {
	config: required("config"),
	kill_after: killAfter,
	resume_step: resumeStep,
	rows: left.rows.size,
	compared_cells: cells,
	differing: differing.length,
	first: differing.slice(0, 20),
	batches_after_resume: {
		rows: expectedBatches.length,
		resumed_rows: resumedBatches.length,
		differing: batchDifferences + Math.abs(expectedBatches.length - resumedBatches.length),
	},
	rng_state_sha256: rng,
}

await writeLocalTextFile(`${log.join("\n")}\n`, out("experiment.log"))
await writeLocalJSONFile(report, out("compare.json"))

console.log(
	`${cells} cells compared, ${differing.length} differ; ${expectedBatches.length} realized rows after the resume, ` +
		`${report.batches_after_resume.differing} differ; final generator states ${rng.uninterrupted === rng.resumed ? "equal" : "differ"}`
)

if (differing.length || report.batches_after_resume.differing || rng.uninterrupted !== rng.resumed) {
	process.exitCode = 1
}
