#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture test for `config/vale/styles/*.yml` (the published-prose and agent-reply rules) and
 *   `config/vale/.vale-chat.ini` — see `packages/dev-mcp/lib/hooks/vale/response/check.ts`).
 *
 *   There is no vitest harness for a set of Vale YAML rule files, so this is the test. Each style
 *   has two fixtures. The dirty one is written to trip every rule file at least once, and also
 *   embeds a code fence, a JSX tag, an import line and a `<details>` block full of the same banned
 *   words, none of which may be flagged — that is the TokenIgnores/BlockIgnores coverage. The clean
 *   one must pass with zero alerts. A rule that stops firing, or an ignore pattern that starts
 *   leaking banned words out of a fence/import/JSX/details block into real alerts, shows up here as
 *   the wrong fixture producing the wrong verdict.
 *
 *   `dirty.md` also carries negative assertions, each checked only by its line staying quiet:
 *
 *   - The phrase "full-text search" sits in plain prose and must not trip `Terms.yml`'s
 *     `text search` swap. That swap is guarded precisely so the FTS5 vocabulary this repo ships
 *     survives it.
 *   - A backticked `neighbourhood` (a real Who's On First placetype) and a backticked `licence`
 *     (Nominatim's response field) must not trip `Spelling.yml`, nor must the JSON fence carrying
 *     both. Vale's markdown parser skips inline code and fences natively, which is the whole reason
 *     those two en-GB-looking identifiers can stay on the swap list.
 *   - `promotion-eval.ts`, `packages/corpus/lib/recipes/` and `mailwoman eval promote` are
 *     backticked, so `AmbiguousShorthand` must stay quiet on all three. That is how a
 *     interface-tied name survives the vocabulary ban without being renamed.
 *
 *   The code leg exists because that last mechanism does not reach a source comment. Vale's
 *   markdown parser skips inline code. Its comment scanner has no markdown parser, so a
 *   backticked identifier in a `//` comment is flagged exactly like bare prose (measured on
 *   @vvago/vale 3.17.0). `AmbiguousShorthandCode.yml` therefore protects interface-tied
 *   names by name, and `dirty.ts` asserts the negative that matters: a backticked `the check` must
 *   still fire. If it stops, the Code rule has been replaced by the markdown one and every name in
 *   the exceptions list is relying on a mechanism that is not there.
 *
 *   Run from anywhere:
 *
 *       node config/vale/check-rules.ts
 *       yarn workspace @mailwoman/docs lint:prose:fixtures
 *
 *   Wired into the docs CI job (`.github/workflows/docs-build.yml`) so a rule regression fails
 *   loudly instead of silently drifting.
 */

import { temporaryDirectory } from "@mailwoman/core/fs/temporary"
import { parseJSONStrict } from "@mailwoman/core/json"
import { repoRootPath, repoRootPathBuilder } from "@mailwoman/core/paths"
import { failScript } from "@mailwoman/core/scripting/utils"
import { valeCommand } from "@mailwoman/core/vale"
import { $ } from "zx"

import { writePythonDocstringProjections } from "#config/vale/python-docstrings"

/**
 * One Vale alert, as emitted by `--output=JSON`.
 *
 * Only the fields this check reads are typed.
 */
interface ValeAlert {
	Check: string
	Severity: string
	Line: number
	Message: string
}

/**
 * Vale's `--output=JSON` document: file path -> alerts.
 *
 * An entirely clean run emits `{}`.
 */
type ValeReport = Record<string, ValeAlert[]>

/**
 * A dirty/clean fixture pair plus the rule files their config is expected to exercise.
 */
interface StyleLeg {
	/**
	 * Human label for the leg's output lines.
	 */
	label: string
	/**
	 * Vale config, relative to the docs directory.
	 */
	config: string
	/**
	 * The fixture written to trip every rule, relative to the docs directory.
	 */
	dirtyFixture: string
	/**
	 * The fixture that must produce no alerts, relative to the docs directory.
	 */
	cleanFixture: string
	/**
	 * The error-severity count the dirty fixture produces today (measured rather than estimated).
	 *
	 * It is a `>=` bar, so adding a rule plus its fixture line passes without a bump.
	 * Only a rule that stops firing fails.
	 */
	minDirtyErrors: number
	/**
	 * Every rule file that must fire at least once, as `Style.Rule` check names.
	 */
	ruleChecks: string[]
	/**
	 * Read the clean fixture's verdict from the JSON rather than the exit code
	 * when the style carries warning-severity rules: Vale's exit code only reflects errors,
	 * so a plain run would pass a clean file that trips a warning.
	 */
	cleanCountsEverySeverity: boolean
	/**
	 * Rules whose alerts must stay absent even when the fixture keeps a warning for another assertion.
	 */
	cleanMustBeAbsent?: string[]
}

const VALE_DIR = repoRootPath("config", "vale")

const LEGS: StyleLeg[] = [
	{
		label: "docs",
		config: ".vale.ini",
		dirtyFixture: "fixtures/dirty.md",
		cleanFixture: "fixtures/clean.md",
		minDirtyErrors: 67,
		ruleChecks: [
			"styles.IngOpeners",
			"styles.AmbiguousShorthand",
			"styles.Anthropomorphism",
			"styles.BannedWords",
			"styles.EmphasisCapitals",
			"styles.ShellNoun",
			"styles.Spelling",
			"styles.StockPhrases",
			"styles.Terms",
			"styles.Weasel",
			"styles.MedicalMetaphor",
			"styles.Negation",
			"styles.Nothing",
			"styles.Grammar.SentenceFragments",
			"styles.Grammar.EllipticalCoordination",
			"styles.Grammar.SloganAssertions",
			"styles.Grammar.RelativeClauseChains",
			"styles.CommaAndClausePile",
			"styles.CommaNo",
			"styles.NamesVerb",
		],
		cleanCountsEverySeverity: false,
		cleanMustBeAbsent: ["styles.CommaAndClausePile"],
	},
	{
		label: "code",
		config: ".vale-code.ini",
		dirtyFixture: "fixtures/dirty.ts",
		cleanFixture: "fixtures/clean.ts",
		minDirtyErrors: 8,
		ruleChecks: [
			"styles.AmbiguousShorthandCode",
			"styles.EmphasisCapitals",
			"styles.ShellNoun",
			"styles.MedicalMetaphor",
			"styles.CommentSemicolons",
			"styles.CommentDashJoint",
			"styles.IngOpeners",
			"styles.Negation",
			"styles.Nothing",
			"styles.Grammar.SentenceFragments",
			"styles.Grammar.EllipticalCoordination",
			"styles.Grammar.SloganAssertions",
			"styles.Grammar.RelativeClauseChains",
			"styles.CommaAndClausePile",
			"styles.CommaNo",
			"styles.NamesVerb",
		],
		cleanCountsEverySeverity: true,
	},
	{
		label: "chat",
		config: ".vale-chat.ini",
		dirtyFixture: "fixtures/dirty-chat.md",
		cleanFixture: "fixtures/clean-chat.md",
		minDirtyErrors: 100,
		ruleChecks: [
			"styles.IngOpeners",
			"styles.AmbiguousShorthand",
			"styles.EmphasisCapitals",
			"styles.ShellNoun",
			"styles.AgreementOpeners",
			"styles.AssertiveFiller",
			"styles.ChatStockForms",
			"styles.DistanceAsSuccess",
			"styles.DecorativeStatusGlyphs",
			"styles.EconomyMetaphor",
			"styles.EmptyTransitions",
			"styles.JudgmentJargon",
			"styles.MintedMetaphor",
			"styles.OpaqueID",
			"styles.OverlaySense",
			"styles.PresentationPreamble",
			"styles.ProjectShorthand",
			"styles.UnsupportedAttribution",
			"styles.VaguePraise",
			"styles.WindDown",
			"styles.MedicalMetaphor",
			"styles.Negation",
			"styles.Nothing",
			"styles.Grammar.SentenceFragments",
			"styles.Grammar.EllipticalCoordination",
			"styles.Grammar.SloganAssertions",
			"styles.Grammar.RelativeClauseChains",
			"styles.CommaNo",
			"styles.NamesVerb",
		],
		cleanCountsEverySeverity: true,
	},
]

const VALE = await valeCommand(import.meta.url)
const $vale = $({ cwd: VALE_DIR, nothrow: true })

/**
 * A single Vale run: its parsed alerts plus the exit code, which the dirty legs assert on.
 */
async function runVale(
	config: string,
	fixtures: string | readonly string[]
): Promise<{ alerts: ValeAlert[]; exitCode: number }> {
	const paths = typeof fixtures === "string" ? [fixtures] : fixtures
	const result = await $vale`${VALE.file} ${VALE.argv} --config ${config} --output=JSON ${paths}`.quiet()

	// Vale can fail by writing details to stderr and leaving stdout empty.
	// Handle that directly so we preserve the real rule/config error message.
	if (!result.stdout.trim()) {
		const detail = result.stderr.trim() || `exit ${result.exitCode ?? 0} with no output for ${paths.join(", ")}`

		failScript(`FAIL: vale produced no report for ${paths.join(", ")} under ${config} — ${detail}`)
	}

	const report = parseJSONStrict<ValeReport>(result.stdout)

	return { alerts: Object.values(report).flat(), exitCode: result.exitCode ?? 0 }
}

async function checkLeg(leg: StyleLeg): Promise<void> {
	process.stdout.write(
		`== ${leg.dirtyFixture}: expect failure, >= ${leg.minDirtyErrors} errors, every rule file represented ==\n`
	)

	const dirty = await runVale(leg.config, leg.dirtyFixture)

	if (dirty.exitCode === 0) {
		failScript(`FAIL: ${leg.dirtyFixture} exited 0 (expected a non-zero exit from error-severity hits)`)
	}

	const errorCount = dirty.alerts.filter((alert) => alert.Severity === "error").length

	if (errorCount < leg.minDirtyErrors) {
		failScript(
			`FAIL: ${leg.dirtyFixture} produced ${errorCount} error-severity hits, expected >= ${leg.minDirtyErrors}`
		)
	}

	for (const check of leg.ruleChecks) {
		if (!dirty.alerts.some((alert) => alert.Check === check)) {
			failScript(`FAIL: rule ${check} did not fire on ${leg.dirtyFixture} (regression)`)
		}
	}

	process.stdout.write(
		`OK: ${leg.dirtyFixture} — ${errorCount} error-severity hits, all ${leg.ruleChecks.length} rule files fired\n`
	)

	const severityLabel = leg.cleanCountsEverySeverity ? "zero alerts of any severity" : "success"

	process.stdout.write(`== ${leg.cleanFixture}: expect ${severityLabel} ==\n`)

	const clean = await runVale(leg.config, leg.cleanFixture)

	if (leg.cleanCountsEverySeverity) {
		if (clean.alerts.length) {
			for (const alert of clean.alerts) {
				process.stderr.write(`  ${leg.cleanFixture}:${alert.Line}  ${alert.Check}  ${alert.Message}\n`)
			}

			failScript(`FAIL: ${leg.cleanFixture} tripped ${clean.alerts.length} alert(s) (false positive)`)
		}
	} else if (clean.exitCode !== 0) {
		for (const alert of clean.alerts) {
			process.stderr.write(`  ${leg.cleanFixture}:${alert.Line}  ${alert.Check}  ${alert.Message}\n`)
		}

		failScript(`FAIL: ${leg.cleanFixture} tripped a rule (false positive)`)
	}

	for (const check of leg.cleanMustBeAbsent ?? []) {
		const alerts = clean.alerts.filter((alert) => alert.Check === check)

		if (alerts.length) {
			for (const alert of alerts) {
				process.stderr.write(`  ${leg.cleanFixture}:${alert.Line}  ${alert.Check}  ${alert.Message}\n`)
			}

			failScript(`FAIL: ${leg.cleanFixture} tripped ${alerts.length} ${check} alert(s)`)
		}
	}

	process.stdout.write(`OK: ${leg.cleanFixture} — 0 alerts\n`)
}

for (const leg of LEGS) {
	await checkLeg(leg)
}

const CODE_TERM_CHECKS = ["words.Nobody", "words.Named", "words.Carry", "words.Alone", "words.Rides", "words.Says"]

process.stdout.write("== fixtures/dirty.ts: expect every code-term rule to warn ==\n")

const dirtyCodeTerms = await runVale(".vale-code-terms.ini", "fixtures/dirty.ts")

for (const check of CODE_TERM_CHECKS) {
	if (!dirtyCodeTerms.alerts.some((alert) => alert.Check === check)) {
		failScript(`FAIL: rule ${check} did not warn on fixtures/dirty.ts (regression)`)
	}
}

process.stdout.write(`OK: fixtures/dirty.ts — all ${CODE_TERM_CHECKS.length} code-term rules warned\n`)
process.stdout.write("== fixtures/clean.ts: expect zero code-term alerts ==\n")

const cleanCodeTerms = await runVale(".vale-code-terms.ini", "fixtures/clean.ts")

if (cleanCodeTerms.alerts.length) {
	for (const alert of cleanCodeTerms.alerts) {
		process.stderr.write(`  fixtures/clean.ts:${alert.Line}  ${alert.Check}  ${alert.Message}\n`)
	}

	failScript(`FAIL: fixtures/clean.ts tripped ${cleanCodeTerms.alerts.length} code-term alert(s)`)
}

process.stdout.write("OK: fixtures/clean.ts — 0 code-term alerts\n")

process.stdout.write("== Python docstrings: expect a warning in the dirty fixture and none in the clean fixture ==\n")

await using scratch = await temporaryDirectory("vale-python-docstring-fixtures-")

const dirtyPython = await writePythonDocstringProjections(
	["config/vale/fixtures/dirty.py"],
	repoRootPathBuilder,
	scratch.path("dirty")
)

const cleanPython = await writePythonDocstringProjections(
	["config/vale/fixtures/clean.py"],
	repoRootPathBuilder,
	scratch.path("clean")
)

const dirtyDocstrings = await runVale(".vale-python-docstrings.ini", dirtyPython.files)
const cleanDocstrings = await runVale(".vale-python-docstrings.ini", cleanPython.files)

if (!dirtyDocstrings.alerts.some((alert) => alert.Check === "styles.CommaAndClausePile")) {
	failScript("FAIL: Python docstring rule did not fire on fixtures/dirty.py")
}

if (cleanDocstrings.alerts.length) {
	for (const alert of cleanDocstrings.alerts) {
		process.stderr.write(`  fixtures/clean.py:${alert.Line}  ${alert.Check}  ${alert.Message}\n`)
	}

	failScript(`FAIL: Python docstring rule tripped ${cleanDocstrings.alerts.length} alert(s) on fixtures/clean.py`)
}

process.stdout.write("OK: Python docstrings — dirty fixture warned; clean fixture produced 0 alerts\n")

process.stdout.write("All Vale rule fixture checks passed.\n")
