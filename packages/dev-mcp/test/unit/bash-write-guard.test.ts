/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * @file The refused set and the admitted set are both the contract, and the admitted set is the one that decides
 *   whether the guard is usable: a guard that refuses ordinary work gets switched off. The cases below came from
 *   driving the first version over the commands a working session runs, where it refused 55 of 56 of them.
 */

import { resolvePackagePath } from "@mailwoman/core/module/resolvers"
import { repoRootPath } from "@mailwoman/core/paths"
import { judgeCommand } from "@mailwoman/dev-mcp/hooks/bash-write-rules"
import { describe, expect, it } from "vitest"

import { runHook } from "../hook-harness.ts"

const HOOK = resolvePackagePath("@mailwoman/dev-mcp", "lib", "hooks", "bash-write-guard.ts")
const REPO_ROOT = String(repoRootPath()).replace(/\/$/u, "")

function refusalFor(command: string): string | null {
	return judgeCommand(command, REPO_ROOT, REPO_ROOT)?.reason ?? null
}

function guidanceFor(command: string): string | null {
	return judgeCommand(command, REPO_ROOT, REPO_ROOT)?.guidance ?? null
}

describe("bash-write-guard: the direct spellings of a file edit", () => {
	it.each([
		["a python heredoc", `cd ${REPO_ROOT} && python3 - <<'PY'\nprint("x")\nPY`],
		["a heredoc writing a module", `cat > packages/core/lib/workspaces.ts <<'TS'\nexport const x = 1\nTS`],
		["sed in place", `sed -i 's|old|new|' packages/tile-worker/wrangler.toml`],
		["sed in place, long flag", `sed --in-place 's/a/b/' AGENTS.md`],
		["sed in place behind a directory change", `cd packages/core && sed -i.bak 's/a/b/' package.json`],
		["awk in place", `awk -i inplace '{print}' AGENTS.md`],
		["sort over its input", `sort -o AGENTS.md AGENTS.md`],
		["an inline node write", `node -e "require('fs').writeFileSync('AGENTS.md', 'x')"`],
		["an inline node copy", `node -e "require('fs').cpSync('/tmp/x','AGENTS.md')"`],
		["an inline python copy", `python3 -c "import shutil; shutil.copy('/tmp/x','AGENTS.md')"`],
		["a redirect into the repository", `echo "{}" > packages/core/tsconfig.json`],
		["an append into the repository", `echo "rule" >> .gitignore`],
		["a numbered redirect into the repository", `yarn compile 2> packages/core/errors.log`],
		["a clobbering redirect", `echo x >| AGENTS.md`],
		["a redirect whose target this hook cannot read", `echo x > "$OUT/AGENTS.md"`],
		["an unadmitted command", `curl -o AGENTS.md https://example.com/x`],
		["a writer behind a wrapper", `env sed -i 's/a/b/' AGENTS.md`],
		["a writer behind xargs", `git ls-files '*.md' | xargs sed -i 's/a/b/'`],
		["a writer behind find", `find packages -name '*.toml' -exec sed -i 's/a/b/' {} \\;`],
		["find deleting", `find packages/core/lib -name '*.ts' -delete`],
		["a writer inside a command substitution", `echo $(sed -i 's/a/b/' AGENTS.md)`],
		["a writer after a single ampersand", `true & sed -i 's/a/b/' AGENTS.md`],
		["a writer in a conditional head", `if sed -i 's/a/b/' AGENTS.md; then echo ok; fi`],
		["a writer after an apostrophe in prose", `echo "don't" && sed -i 's/a/b/' AGENTS.md`],
		["git apply", `git apply /tmp/patch.diff`],
		["git restoring a path", `git restore packages/core/lib/env.ts`],
		["git checkout over a pathspec", `git checkout -- packages/core`],
		["git config writing a manifest", `git config -f packages/core/package.json foo.bar baz`],
		["npm rewriting a manifest", `npm pkg set scripts.evil=x`],
		["yarn running an arbitrary program", `yarn dlx replace-in-file a b AGENTS.md`],
		["vitest rewriting snapshots", `yarn vitest run -u packages/core`],
		["a copy into the repository", `cp /tmp/x AGENTS.md`],
		["a removal inside the repository", `rm -rf packages/core/lib`],
		["tee into the repository", `yarn compile | tee packages/core/build.log`],
	])("refuses %s", (_label, command) => {
		expect(refusalFor(command)).not.toBeNull()
	})

	it("names the command it did not admit", () => {
		expect(refusalFor(`curl -sS https://example.com`)).toContain("`curl`")
	})
})

describe("bash-write-guard: a Modal launch this shell could kill", () => {
	// Both spellings have cost a training run. `timeout 600 modal run -d …` killed the v3.0.0 span-head probe at step
	// ~1000 of 2000 on 2026-07-15 with no checkpoint written; `run_in_background` on `modal run -d …` was stopped by the
	// host's memory guard on 2026-09-09 and Modal cancelled the input at step 21,000 of 60,000, last save at 20,000.
	it.each([
		["a detached launch", `modal run -d corpus-python/modal/train_remote.py --config x.yaml`],
		["a detached launch, long flag", `modal run --detach corpus-python/modal/train_remote.py --config x.yaml`],
		["a timed launch", `timeout 600 modal run -d corpus-python/modal/train_remote.py --config x.yaml`],
		["a timed Modal command with no detach", `timeout 200 modal run corpus-python/modal/train_remote.py::audit`],
		["a detached launch behind a directory change", `cd corpus-python && modal run -d modal/train_remote.py`],
	])("refuses %s", (_label, command) => {
		expect(refusalFor(command)).not.toBeNull()
	})

	it("explains process ownership rather than the Write tool", () => {
		const command = `modal run -d corpus-python/modal/train_remote.py --config x.yaml`

		expect(guidanceFor(command)).toContain("launch-detached.run.ts")
		expect(guidanceFor(command)).not.toContain("Edit tool")
	})

	it("still points a file-write refusal at the Write tool", () => {
		expect(guidanceFor(`sed -i 's/a/b/' AGENTS.md`)).toContain("Edit tool")
	})
})

describe("bash-write-guard: the work a session actually does", () => {
	it.each([
		["a build whose log lands outside the repository", `{ yarn compile; echo "EXIT=$?"; } > /tmp/compile.log 2>&1`],
		["a test run", `yarn vitest run packages/core --reporter dot 2>&1 | tail -5`],
		["a search", `grep -rn "readPackageJSON" --include="*.ts" packages | head -20`],
		["a probe that prints", `node -e "console.log(require('./package.json').version)"`],
		["a module probe that prints", `node --input-type=module -e "import x from './a.ts'; console.log(x)"`],
		["a probe writing to stdout", `node -e "process.stdout.write('hi')"`],
		// oxlint-disable-next-line mailwoman/prefer-home -- a fixture command string, not this file reading git state.
		["git staging", `git add -A && git status --porcelain`],
		["a formatter over its own inputs", `npx oxfmt .`],
		["the formatter writing its derivation", `yarn oxfmt --write packages/core/lib/env.ts`],
		["the linter applying its own fixes", `yarn oxlint --fix packages/core/lib`],
		["the linter applying its own fixes, bare", `oxlint --fix packages/core/lib`],
		["a compiler emitting into out/", `yarn compile`],
		["discarding output", `git fetch origin main -q 2>/dev/null`],
		["sed in its reading spelling", `sed -n '10,20p' AGENTS.md`],
		["a pipeline of readers", `git ls-files '*.ts' | xargs wc -l | sort -rn | head -5`],
		["a loop over admitted commands", `for f in a b c; do wc -l "$f"; done`],
		["a subshell group piped into a reader", `(git diff --name-only HEAD; git diff --cached --name-only) | sort -u`],
		["process substitution as an argument", `comm -12 <(sort /tmp/a.txt) /tmp/b.txt`],
		["reading the stash", `git stash list`],
		["switching branch", `git checkout -b feature/x`],
		["a conditional", `if test -f AGENTS.md; then head -1 AGENTS.md; fi`],
		["a scratch directory", `mkdir -p /tmp/scratch && rm -rf /tmp/scratch`],
		["a copy out of the repository", `cp AGENTS.md /tmp/`],
		["a log captured through tee outside the tree", `yarn compile 2>&1 | tee /tmp/compile.log`],
		["a timeout around a test run", `timeout 600 yarn test`],
		["this repository's operator CLI", `yarn mwops health all`],
		["a short Modal command with no detach and no timeout", `modal run corpus-python/modal/train_remote.py::sync_v540`],
		["a Modal volume read", `modal volume ls mailwoman-training /output-v540/checkpoints`],
		[
			"the detached launcher itself",
			`node packages/mailwoman/lib/dev-tools/launch-detached.run.ts --log /tmp/r.log -- modal run -d x.py`,
		],
		["a release checksum", `sha256sum /tmp/package.tgz`],
		["a database probe", `sqlite3 /tmp/wof.db 'select count(*) from place'`],
		["an environment assignment", `MAILWOMAN_DATA_ROOT=\${HOME}/data yarn test`],
		["a redirect after changing directory", `cd /tmp && echo hi > probe.txt`],
		["a home-relative redirect", `echo x > ~/notes.txt`],
	])("admits %s", (_label, command) => {
		expect(refusalFor(command)).toBeNull()
	})
})

describe("bash-write-guard: the hook around the judgement", () => {
	it("answers a deny decision on stdout", () => {
		const output = runHook(HOOK, {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			cwd: REPO_ROOT,
			tool_input: { command: `sed -i 's/a/b/' AGENTS.md` },
		})

		expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
		expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Edit tool")
	})

	it("denies a Modal launch through the adapter, with the launcher in the reason", () => {
		const output = runHook(HOOK, {
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			cwd: REPO_ROOT,
			tool_input: { command: `modal run -d corpus-python/modal/train_remote.py --config x.yaml` },
		})

		expect(output.hookSpecificOutput?.permissionDecision).toBe("deny")
		expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("launch-detached.run.ts")
	})

	it("ignores a tool that is not Bash", () => {
		const output = runHook(HOOK, {
			tool_name: "Write",
			cwd: REPO_ROOT,
			tool_input: { command: `sed -i 's/a/b/' AGENTS.md` },
		})

		expect(output.hookSpecificOutput).toBeUndefined()
	})

	it("admits an unreadable payload rather than halting the shell", () => {
		expect(runHook(HOOK, "{not json")).toEqual({})
	})
})
