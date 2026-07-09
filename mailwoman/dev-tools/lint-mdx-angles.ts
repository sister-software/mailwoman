/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Raw-angle-bracket MDX lint. Docusaurus compiles BOTH .md and .mdx through micromark's MDX-JSX
 *   extension, so a bare `<55` or `{word` in prose is a BUILD-BREAKING parse error ("Unexpected
 *   character before name"). This class broke three builds on 2026-06-10 alone (the consolidation
 *   session doc, the deep-dive review, the fill-rate record) — hence this gate.
 *
 *   Checks STAGED docs markdown by default (pre-commit), or explicit paths when given. Skips fenced
 *   code blocks and inline code; flags raw `<` before a digit or `{` before a letter.
 *
 *   Stays quiet and fast — it runs on every `main` commit via the husky pre-commit hook. Run:
 *   mailwoman dev lint mdx-angles [files...]
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

/**
 * The build-breaking class is `<55`-style numeric prose and `{word`-style MDX JSX expressions. Uppercase `<Component>`
 * is legitimate MDX JSX and lowercase `<word>` is usually real HTML — flagging them false-positives on valid docs (bit
 * the pipeline-contract page, night-11). Braces joined 2026-06-11: bare `{word` in prose is an MDX JSX EXPRESSION —
 * `{raw, components}` broke main's SSG with `ReferenceError: raw is not defined`. Same fix menu: backtick it.
 */
const RAW_ANGLE = /<[0-9]|\{[a-zA-Z]/

/** Options for {@linkcode lintMDXAngles}. */
export interface LintMDXAnglesOptions {
	/** Files to check. Default: staged `docs/**` markdown (the pre-commit mode). */
	files?: string[]
}

/** One flagged file: its path + the offending 1-based `line:text` hits. */
export interface MDXAngleFinding {
	file: string
	hits: string[]
}

/** Findings summary returned by {@linkcode lintMDXAngles}. */
export interface LintMDXAnglesSummary {
	/** Number of files flagged — the command exits 1 when nonzero. */
	errors: number
	warnings: number
	filesChecked: number
	findings: MDXAngleFinding[]
}

function stagedDocsMarkdown(): string[] {
	const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" })

	return out
		.split("\n")
		.map((f) => f.trim())
		.filter((f) => /^docs\/.*\.(md|mdx)$/.test(f))
}

/**
 * Strip fenced code blocks, then inline code spans, then collect 1-based lines that hit {@link RAW_ANGLE}.
 */
function violations(file: string): string[] {
	const hits: string[] = []
	let fenced = false
	const lines = readFileSync(file, "utf8").split("\n")

	for (const [i, line] of lines.entries()) {
		if (line.startsWith("```")) {
			fenced = !fenced
			continue
		}

		if (fenced) continue
		const stripped = line.replace(/`[^`]*`/g, "")

		if (RAW_ANGLE.test(stripped)) {
			hits.push(`${i + 1}:${line}`)
		}
	}

	return hits
}

/** Lint the given (or staged) docs markdown for build-breaking raw angles/braces. */
export function lintMDXAngles(
	options: LintMDXAnglesOptions = {},
	report?: (line: string) => void
): LintMDXAnglesSummary {
	const targets = options.files?.length ? options.files : stagedDocsMarkdown()
	const findings: MDXAngleFinding[] = []
	let filesChecked = 0

	for (const f of targets) {
		if (!existsSync(f)) continue
		filesChecked++
		const hits = violations(f)

		if (hits.length > 0) {
			report?.(`✗ ${f} — raw '<' before alphanumeric (MDX parses it as a JSX tag; build will fail):`)

			for (const h of hits.slice(0, 5)) {
				report?.(`    ${h}`)
			}
			findings.push({ file: f, hits })
		}
	}

	if (findings.length > 0) {
		report?.("")
		report?.("Fix: backtick the expression, spell it out, or escape the brace/angle.")
	}

	return { errors: findings.length, warnings: 0, filesChecked, findings }
}
