#!/usr/bin/env node
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The cheap board-pin check as a CI runner (#1895): measure the committed corpus's pins and
 *   compare them with the constants the pin test carries. Loads only the committed JSONL — no
 *   model, no gazetteer, no warm engine — so the workflow that runs it needs an install and nothing
 *   else. Exits nonzero on drift with the exact replacement values.
 *
 *   `--report-issue` (main-audit mode) additionally opens or updates ONE deduplicated issue via
 *   `gh` when the pins are stale — the backstop for a stale pin reaching `main` through an
 *   admin-merge that bypassed the wrapper or a web edit. One issue, updated in place; never an
 *   issue per commit.
 */

import { execFileSync } from "node:child_process"
import { parseArgs } from "node:util"

import { parseJSONStrict } from "@mailwoman/core/objects"
import { runIfScript } from "@mailwoman/core/scripting"

import { checkBoardPins, PIN_TEST_PATH } from "../packages/mailwoman/eval-harness/gauntlet/cases/pins.ts"

const ISSUE_TITLE = "board pins are stale on main"

function gh(args: string[]): string {
	return execFileSync("gh", args, { encoding: "utf8" })
}

async function checkBoardPinsCLI(): Promise<void> {
	const { values } = parseArgs({
		options: {
			"report-issue": { type: "boolean", default: false },
		},
	})

	const check = await checkBoardPins()

	if (!check.stale.length) {
		process.stderr.write(`✓ board pins hold (${check.measured.CORPUS_SIZE} rows)\n`)

		return
	}

	const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()

	const drift = check.stale
		.map((key) => `- ${key}: committed ${String(check.committed[key])} → measured ${String(check.measured[key])}`)
		.join("\n")

	process.stderr.write(`✗ the committed pins are STALE in ${PIN_TEST_PATH} at ${commit.slice(0, 12)}:\n${drift}\n`)

	if (values["report-issue"]) {
		const body =
			`The board-pin audit found the committed constants stale at ${commit}:\n\n${drift}\n\n` +
			`Run \`mailwoman eval pins --update\`, commit ${PIN_TEST_PATH}, and this issue closes on the next green audit.`

		const existing = parseJSONStrict<Array<{ number: number }>>(
			gh([
				"issue",
				"list",
				"--state",
				"open",
				"--search",
				`in:title ${JSON.stringify(ISSUE_TITLE)}`,
				"--json",
				"number",
			])
		)

		if (existing.length) {
			gh(["issue", "comment", String(existing[0]!.number), "--body", body])
			process.stderr.write(`updated issue #${existing[0]!.number}\n`)
		} else {
			gh(["issue", "create", "--title", ISSUE_TITLE, "--body", body])
			process.stderr.write("opened the audit issue\n")
		}
	}

	process.exitCode = 1
}

runIfScript(import.meta, checkBoardPinsCLI)
