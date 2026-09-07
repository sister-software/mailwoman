/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The refused set and the allowed set are both the contract. Every command below is one this session actually
 *   ran on 2026-09-07 — the refusals are the edits that bypassed `symbol-precheck`, and the allowances are the
 *   read-only and log-capturing shapes that a blunter rule would have taken with them.
 */

import { tryParsingJSON } from "@mailwoman/core/json"
import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { runFileSync } from "@mailwoman/core/process"
import { describe, expect, it } from "vitest"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "bash-write-guard.ts")
const REPO_ROOT = String(repoRootPath())

interface HookOutput {
	hookSpecificOutput?: {
		hookEventName?: string
		permissionDecision?: string
		permissionDecisionReason?: string
	}
}

function runHook(command: string, toolName = "Bash"): HookOutput {
	const stdout = runFileSync("node", [HOOK], {
		cwd: REPO_ROOT,
		input: JSON.stringify({
			hook_event_name: "PreToolUse",
			tool_name: toolName,
			cwd: REPO_ROOT,
			tool_input: { command },
		}),
		encoding: "utf8",
	})

	return tryParsingJSON<HookOutput>(stdout) ?? {}
}

function decisionFor(command: string): string | undefined {
	return runHook(command).hookSpecificOutput?.permissionDecision
}

describe("bash-write-guard: the shapes that skipped the symbol precheck", () => {
	it.each([
		["a python heredoc rewriting a source file", `cd ${REPO_ROOT} && python3 - <<'PY'\nprint("x")\nPY`],
		["a heredoc writing a new module", `cat > packages/core/lib/workspaces.ts <<'TS'\nexport const x = 1\nTS`],
		["sed in place", `sed -i 's|old|new|' packages/tile-worker/wrangler.toml`],
		["sed in place behind a directory change", `cd packages/core && sed -i.bak 's/a/b/' package.json`],
		["perl, which is not admitted at all", `perl -i -pe 's/a/b/' AGENTS.md`],
		["an inline node write", `node -e "require('fs').writeFileSync('AGENTS.md', 'x')"`],
		["a redirect into the repository", `echo "{}" > packages/core/tsconfig.json`],
		["an append into the repository", `echo "rule" >> .gitignore`],
		["an unadmitted command", `curl -o AGENTS.md https://example.com/x`],
		// oxlint-disable-next-line mailwoman/prefer-home -- a fixture command string, not this file reading git state.
		["an unadmitted command behind an admitted one", `git status --porcelain && tee AGENTS.md`],
	])("refuses %s", (_label, command) => {
		expect(decisionFor(command)).toBe("deny")
	})

	it("names the command it did not admit", () => {
		const reason = runHook(`curl -sS https://example.com`).hookSpecificOutput?.permissionDecisionReason ?? ""

		expect(reason).toContain("`curl`")
		expect(reason).toContain("ADMITTED")
	})

	it("says which tool to use instead", () => {
		const reason = runHook(`sed -i 's/a/b/' AGENTS.md`).hookSpecificOutput?.permissionDecisionReason ?? ""

		expect(reason).toContain("Edit tool")
		expect(reason).toContain("symbol precheck")
	})
})

describe("bash-write-guard: what stays legal", () => {
	it.each([
		["a build whose log lands outside the repository", `{ yarn compile; echo "EXIT=$?"; } > /tmp/compile.log 2>&1`],
		["a test run with a plain descriptor duplication", `yarn vitest run packages/core --reporter dot 2>&1 | tail -5`],
		["a search", `grep -rn "readPackageJSON" --include="*.ts" packages | head -20`],
		["a probe that prints", `node -e "console.log(require('./package.json').version)"`],
		["a module probe that prints", `node --input-type=module -e "import { x } from './a.ts'; console.log(x)"`],
		// oxlint-disable-next-line mailwoman/prefer-home -- a fixture command string, not this file reading git state.
		["git staging", `git add -A && git status --porcelain`],
		["a formatter that rewrites its own inputs", `npx oxfmt .`],
		["a compiler that emits into out/", `yarn compile`],
		["discarding output", `git fetch origin main -q 2>/dev/null`],
		["sed in its reading spelling", `sed -n '10,20p' AGENTS.md`],
		["a pipeline of readers", `git ls-files '*.ts' | xargs wc -l | sort -rn | head -5`],
	])("allows %s", (_label, command) => {
		expect(decisionFor(command)).toBeUndefined()
	})

	/**
	 * The refusing version of this hook refused its own commit: the message quoted `sed -i` in prose. Quoted text is
	 * data, and a hook that reads it as a command cannot describe a writer in a commit message ever again.
	 */
	it("admits a commit whose message describes a writer", () => {
		const command = `git commit -m "fix: an edit made with a heredoc or \\\`sed -i\\\` never reaches the precheck"`

		expect(decisionFor(command)).toBeUndefined()
	})

	it("admits a grep whose pattern contains a writer", () => {
		expect(decisionFor(`grep -rn "sed -i" packages --include="*.md"`)).toBeUndefined()
	})

	it("ignores a tool that is not Bash", () => {
		expect(runHook(`sed -i 's/a/b/' AGENTS.md`, "Write").hookSpecificOutput).toBeUndefined()
	})
})
