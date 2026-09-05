#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Fixture test for `docs/styles/Mailwoman/*.yml` (the published-prose rules) and
 *   `docs/styles/MailwomanChat/*.yml` (the agent-reply rules the Stop hook runs through
 *   `.vale-chat.ini` — see `packages/dev-mcp/lib/hooks/vale-response-check.ts`).
 *
 *   There is no vitest harness for a set of Vale YAML rule files, so this is the test. Each style
 *   has two fixtures. The dirty one is written to trip every rule file at least once, and also
 *   embeds a code fence, a JSX tag, an import line and a `<details>` block full of the same banned
 *   words, none of which may be flagged — that is the TokenIgnores/BlockIgnores coverage. The clean
 *   one must pass with zero alerts. A rule that stops firing, or an ignore pattern that starts
 *   leaking banned words out of a fence/import/JSX/details block into real alerts, shows up here as
 *   the wrong fixture producing the wrong verdict.
 *
 *   `dirty.md` also carries NEGATIVE assertions, each checked only by its line staying quiet:
 *
 *   - The phrase "full-text search" sits in plain prose and must NOT trip `Terms.yml`'s
 *     `text search` swap. That swap is guarded precisely so the FTS5 vocabulary this repo ships
 *     survives it.
 *   - A backticked `neighbourhood` (a real Who's On First placetype) and a backticked `licence`
 *     (Nominatim's response field) must NOT trip `Spelling.yml`, nor must the JSON fence carrying
 *     both. Vale's markdown parser skips inline code and fences natively, which is the whole reason
 *     those two en-GB-looking identifiers can stay on the swap list.
 *   - `promotion-eval.ts`, `packages/corpus/lib/recipes/` and `mailwoman eval promote` are
 *     backticked, so `AmbiguousShorthand` must stay quiet on all three — that is how a
 *     contract-bearing name survives the vocabulary ban without being renamed.
 *
 *   The CODE leg exists because that last mechanism does not reach a source comment. Vale's
 *   markdown parser skips inline code; its comment scanner has no markdown parser, so a
 *   backticked identifier in a `//` comment is flagged exactly like bare prose (measured on
 *   @vvago/vale 3.17.0). `Mailwoman/AmbiguousShorthandCode.yml` therefore protects contract-bearing
 *   names by NAME, and `dirty.ts` asserts the negative that matters: a backticked `the check` MUST
 *   still fire. If it stops, the Code rule has been replaced by the markdown one and every name in
 *   the exceptions list is relying on a mechanism that is not there.
 *
 *   Run from anywhere:
 *
 *       node docs/scripts/check-vale-rules.ts
 *       yarn workspace @mailwoman/docs lint:prose:fixtures
 *
 *   Wired into the docs CI job (`.github/workflows/docs-build.yml`) so a rule regression fails
 *   loudly instead of silently drifting.
 */

import { parseJSONStrict } from "@mailwoman/core/json"
import { createRequire } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { failScript } from "@mailwoman/core/scripting/utils"
import { dirname, join } from "path-ts"
import { $ } from "zx"

/**
 * One Vale alert, as emitted by `--output=JSON`. Only the fields this check reads are typed.
 */
interface ValeAlert {
	Check: string
	Severity: string
	Line: number
	Message: string
}

/**
 * Vale's `--output=JSON` document: file path -> alerts. An entirely clean run emits `{}`.
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
	 * The error-severity count the dirty fixture produces today (measured, not estimated). It is a `>=` bar, so adding a
	 * rule plus its fixture line passes without a bump; only a rule that STOPS firing fails.
	 */
	minDirtyErrors: number
	/**
	 * Every rule file that must fire at least once, as `Style.Rule` check names.
	 */
	ruleChecks: string[]
	/**
	 * Read the clean fixture's verdict from the JSON rather than the exit code when the style carries warning-severity
	 * rules: Vale's exit code only reflects errors, so a plain run would pass a clean file that trips a warning.
	 */
	cleanCountsEverySeverity: boolean
}

const DOCS_DIR = repoRootPath("docs")

const LEGS: StyleLeg[] = [
	{
		label: "docs",
		config: ".vale.ini",
		dirtyFixture: "scripts/vale-fixtures/dirty.md",
		cleanFixture: "scripts/vale-fixtures/clean.md",
		minDirtyErrors: 67,
		ruleChecks: [
			"Mailwoman.AmbiguousShorthand",
			"Mailwoman.Anthropomorphism",
			"Mailwoman.BannedWords",
			"Mailwoman.Spelling",
			"Mailwoman.StockPhrases",
			"Mailwoman.Terms",
			"Mailwoman.Weasel",
		],
		cleanCountsEverySeverity: false,
	},
	{
		label: "code",
		config: ".vale-code.ini",
		dirtyFixture: "scripts/vale-fixtures/dirty.ts",
		cleanFixture: "scripts/vale-fixtures/clean.ts",
		minDirtyErrors: 7,
		ruleChecks: ["Mailwoman.AmbiguousShorthandCode"],
		// The Code rule is error-severity and it is the only rule this config runs, so the exit
		// code carries the whole verdict.
		cleanCountsEverySeverity: false,
	},
	{
		label: "chat",
		config: ".vale-chat.ini",
		dirtyFixture: "scripts/vale-fixtures/dirty-chat.md",
		cleanFixture: "scripts/vale-fixtures/clean-chat.md",
		minDirtyErrors: 77,
		ruleChecks: [
			"Mailwoman.AmbiguousShorthand",
			"MailwomanChat.AgreementOpeners",
			"MailwomanChat.AssertiveFiller",
			"MailwomanChat.ChatStockForms",
			"MailwomanChat.DistanceAsSuccess",
			"MailwomanChat.DecorativeStatusGlyphs",
			"MailwomanChat.EconomyMetaphor",
			"MailwomanChat.EmptyTransitions",
			"MailwomanChat.JudgmentJargon",
			"MailwomanChat.MintedMetaphor",
			"MailwomanChat.OpaqueID",
			"MailwomanChat.PresentationPreamble",
			"MailwomanChat.ProjectShorthand",
			"MailwomanChat.UnsupportedAttribution",
			"MailwomanChat.VaguePraise",
			"MailwomanChat.WindDown",
		],
		cleanCountsEverySeverity: true,
	},
]

/**
 * Locate the Vale binary through Node's own resolution algorithm.
 *
 * `@vvago/vale` is a devDependency of this workspace, but yarn's node-modules linker hoists it to whichever install
 * directory has no conflicting version — the repo root here, not `docs/`. Asking `require.resolve` for the package
 * manifest and joining from its directory finds it wherever the linker put it, and keeps this file clear of the
 * hand-assembled install path that the `node-modules-reacharound` check in `packages/repo-health` refuses.
 */
function resolveValeBinary(): string {
	const manifest = createRequire(import.meta.url).resolve("@vvago/vale/package.json")

	return join(dirname(manifest), "bin", "vale")
}

const VALE_BIN = resolveValeBinary()
const $vale = $({ cwd: DOCS_DIR, nothrow: true })

/**
 * A single Vale run: its parsed alerts plus the exit code, which the dirty legs assert on.
 */
async function runVale(config: string, fixture: string): Promise<{ alerts: ValeAlert[]; exitCode: number }> {
	const result = await $vale`${VALE_BIN} --config ${config} --output=JSON ${fixture}`.quiet()
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

	process.stdout.write(`OK: ${leg.cleanFixture} — 0 alerts\n`)
}

for (const leg of LEGS) {
	await checkLeg(leg)
}

process.stdout.write("All Vale rule fixture checks passed.\n")
