/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 * @file The cold trial of the get-started pages: prove their pasted transcripts against a REAL consumer install, not the
 *   monorepo's hoisted `node_modules`. A workspace-linked dev tree resolves things a stranger's `npm install` never
 *   would (a sibling package, a locale overlay), which is the trap `smoke-clean-install` exists for too.
 *
 *   Method: pack the closure the three seeds pull in (`mailwoman`, `@mailwoman/neural`,
 *   `@mailwoman/neural-weights-en-us` — every `workspace:` dependency, walked from the manifests), `npm install` the
 *   tarballs into a project outside the repo tree, then run the pages' commands verbatim and assert their claims.
 *
 *   Two legs, split on whether the step needs network beyond npm's own registry fetch. Always on: the
 *   install-and-first-parse script, `mailwoman doctor` cold against an absent data root, and the shell parse. Behind
 *   `full`: a real `mailwoman data pull candidate` (~1.65 GB) and the two `mailwoman geocode` calls of the ten-minute
 *   trial's step 5, against a data root the caller may supply so the pull is not repeated.
 *
 *   Pages this proves: `docs/articles/developers/get-started/install-and-first-parse.mdx`,
 *   `docs/articles/developers/get-started/ten-minute-trial.mdx`.
 */

import { pathExists } from "@mailwoman/core/fs/readers"
import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { makeDirectories, writeLocalJSONFile, writeLocalTextFile } from "@mailwoman/core/fs/writers"
import { runFileSync } from "@mailwoman/core/process"
import { join } from "path-ts"

import { packWorkspaces, walkWorkspaceClosure } from "#release/workspace-closure"

/**
 * The packages the get-started pages tell a reader to install. Their closure is computed, never listed.
 */
export const GET_STARTED_SEEDS = ["mailwoman", "@mailwoman/neural", "@mailwoman/neural-weights-en-us"] as const

/**
 * Install-and-first-parse.mdx's script, verbatim. The page and this string must say the same thing.
 */
const FIRST_PARSE_SCRIPT = `import { createRuntimePipeline } from "mailwoman"
import { NeuralAddressClassifier } from "@mailwoman/neural"

const classifier = await NeuralAddressClassifier.loadFromWeights({ locale: "en-US" })
const parse = createRuntimePipeline({ classifier })

const result = await parse("apt 4b 350 5th ave new york ny 10118")

console.log("input:", result.input)
console.log("locale:", result.locale.locale)
console.log("kind:", result.kind.kind)
console.log()

function print(node, depth = 0) {
	const pad = "  ".repeat(depth)
	console.log(\`\${pad}\${node.tag}: "\${node.value}"  (confidence \${node.confidence.toFixed(2)})\`)
	for (const child of node.children) print(child, depth + 1)
}

for (const root of result.tree.roots) print(root)
`

const FIRST_PARSE_NEEDLES = [
	"locale: en-US",
	"kind: structured_address",
	'locality: "New York"',
	'postcode: "10118"',
	'house_number: "350"',
]

const DOCTOR_NEEDLES = [
	"Model weights (en-us)",
	"Node runtime",
	"ONNX runtime",
	"mailwoman data pull candidate",
	"mailwoman data pull poi",
	"not installed",
	"PASS",
]

const SHELL_PARSE_INPUT = "350 5th Ave, New York, NY 10118"
const SHELL_PARSE_NEEDLES = ['"locality": "New York"', '"postcode": "10118"', '"house_number": "350"']

export interface SmokeGetStartedOptions {
	repoRoot: string
	log: (line: string) => void
	/**
	 * Run the heavy leg: a real `data pull candidate` and the two geocodes.
	 */
	full?: boolean
	/**
	 * A persistent data root for the heavy leg, so the ~1.65 GB pull is not repeated. Default: a scratch directory.
	 */
	dataRoot?: string
}

export interface SmokeGetStartedReport {
	packed: number
	legs: string[]
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
	return runFileSync(cmd, args, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		// oxlint-disable-next-line sister-software/no-process-globals -- the child must inherit PATH and the rest; only the data root is added
		env: { ...process.env, ...env },
	})
}

function assertNeedles(output: string, needles: readonly string[], page: string): void {
	for (const needle of needles) {
		if (!output.includes(needle)) {
			throw new Error(
				`${page}: output is missing ${JSON.stringify(needle)}; the page's transcript no longer matches:\n${output.slice(0, 1200)}`
			)
		}
	}
}

/**
 * Pack the seeds' closure, install it into a throwaway project, and run the two pages' transcripts. Throws on the first
 * claim that no longer holds, naming the page.
 */
export async function smokeGetStarted(options: SmokeGetStartedOptions): Promise<SmokeGetStartedReport> {
	const { repoRoot, log } = options
	const legs: string[] = []

	await using tmp = await temporaryDirectory("mw-get-started-")
	const tarDir = String(tmp.resolve("tarballs"))
	const project = String(tmp.resolve("project"))
	// doctor's own "data root does not exist" branch needs the directory ABSENT, not empty.
	const doctorRoot = String(tmp.resolve("doctor-root-absent"))

	await makeDirectories(tarDir, project)

	const closure = await walkWorkspaceClosure(repoRoot, GET_STARTED_SEEDS)

	log(`[get-started] packing the ${closure.size}-workspace closure of ${GET_STARTED_SEEDS.join(", ")}…`)

	const dependencies = await packWorkspaces(repoRoot, closure, tarDir)

	await writeLocalJSONFile(
		{ name: "mw-get-started-trial", private: true, type: "module", dependencies },
		join(project, "package.json")
	)

	log("[get-started] npm install (tarballs only — no hoisting)…")
	run("npm", ["install", "--no-audit", "--no-fund", "--no-package-lock"], project)

	const cli = join(project, "node_modules", "mailwoman", "out", "cli.js")

	log("[get-started] install-and-first-parse.mdx: the parse script…")
	await writeLocalTextFile(FIRST_PARSE_SCRIPT, join(project, "parse.mjs"))
	assertNeedles(run("node", ["parse.mjs"], project), FIRST_PARSE_NEEDLES, "install-and-first-parse.mdx")
	legs.push("first-parse")

	log("[get-started] ten-minute-trial.mdx step 2: mailwoman doctor, cold, against an absent data root…")

	let doctor: string

	try {
		doctor = run("node", [cli, "doctor"], project, { MAILWOMAN_DATA_ROOT: doctorRoot })
	} catch (error) {
		// doctor exits non-zero when a check fails, which is the cold state the page shows; the transcript is what counts.
		doctor = error instanceof Error && "stdout" in error ? String((error as { stdout: unknown }).stdout) : String(error)
	}

	assertNeedles(doctor, DOCTOR_NEEDLES, "ten-minute-trial.mdx (doctor)")

	if (doctor.includes("export MAILWOMAN_CANDIDATE_DB")) {
		throw new Error(
			"ten-minute-trial.mdx (doctor): doctor prints an export line, but the page teaches the bare pull as the whole fix"
		)
	}

	legs.push("doctor")

	log("[get-started] ten-minute-trial.mdx step 3: mailwoman parse (shell)…")
	assertNeedles(
		run("node", [cli, "parse", SHELL_PARSE_INPUT], project),
		SHELL_PARSE_NEEDLES,
		"ten-minute-trial.mdx (parse)"
	)
	legs.push("shell-parse")

	if (!options.full) {
		log("[get-started] full leg off — skipping the candidate.db pull and the two geocodes")

		return { packed: closure.size, legs }
	}

	const dataRoot = options.dataRoot ?? String(tmp.resolve("data-root"))

	await makeDirectories(dataRoot)

	const candidateDB = join(dataRoot, "wof", "candidate.db")

	if (await pathExists(candidateDB)) {
		log(`[get-started] candidate.db already at ${candidateDB} — skipping the pull`)
	} else {
		log("[get-started] mailwoman data pull candidate (~1.65 GB — the heavy leg)…")

		const pull = run("node", [cli, "data", "pull", "candidate"], project, { MAILWOMAN_DATA_ROOT: dataRoot })

		if (!pull.includes("PASS") || !(await pathExists(candidateDB))) {
			throw new Error(`data pull candidate did not land ${candidateDB}:\n${pull.slice(0, 1200)}`)
		}
	}

	log("[get-started] ten-minute-trial.mdx step 5: mailwoman geocode, US…")

	assertNeedles(
		run("node", [cli, "geocode", SHELL_PARSE_INPUT], project, { MAILWOMAN_DATA_ROOT: dataRoot }),
		['"locality": "New York"', '"region": "NY"', '"countryCode": "US"'],
		"ten-minute-trial.mdx (geocode US)"
	)

	log("[get-started] ten-minute-trial.mdx step 5: mailwoman geocode, FR — the ledgered routing case…")

	assertNeedles(
		run("node", [cli, "geocode", "12 Rue de Rivoli, 75001 Paris"], project, { MAILWOMAN_DATA_ROOT: dataRoot }),
		['"countryCode": "FR"'],
		"ten-minute-trial.mdx (geocode FR — a US answer here is the candidate backend's Paris-Texas misroute)"
	)

	legs.push("geocode-us", "geocode-fr")

	return { packed: closure.size, legs }
}
