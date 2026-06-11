/**
 * Mailwoman Guard Extension
 *
 * Combines four guards for the mailwoman monorepo:
 * 1. Protected-paths block — write/edit to release-critical files/dirs triggers confirm
 * 2. Symlink detection — bash commands touching neural-weights-* check for symlinks
 * 3. Release pre-flight — yarn release / npm publish checks git cleanliness + weights existence
 * 4. Wrapped bash tool — injects MAILWOMAN_ROOT env var via createBashTool spawnHook
 *
 * Patterns from: protected-paths.ts, bash-spawn-hook.ts, permission-gate.ts, dirty-repo-guard.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_ROOT = process.cwd();

// ---- Guard 1: Protected paths ----
const PROTECTED_PATHS = [
	"neural-weights-en-us/",
	"neural-weights-fr-fr/",
	"core/data/",
	".release-it.json",
	"release.config.json",
];

function isPathProtected(targetPath: string): boolean {
	const rel = targetPath.replace(PROJECT_ROOT + "/", "");
	return PROTECTED_PATHS.some((p) => rel.startsWith(p) || rel === p);
}

// ---- Guard 2: Symlink detection ----
const WEIGHTS_FILES = [
	"neural-weights-en-us/model.onnx",
	"neural-weights-en-us/tokenizer.model",
	"neural-weights-fr-fr/model.onnx",
	"neural-weights-fr-fr/tokenizer.model",
];

function findSymlinkedWeights(): string[] {
	const symlinks: string[] = [];
	for (const rel of WEIGHTS_FILES) {
		const abs = resolve(PROJECT_ROOT, rel);
		try {
			const stat = lstatSync(abs);
			if (stat.isSymbolicLink()) {
				symlinks.push(rel);
			}
		} catch {
			// File absent — not a symlink threat
		}
	}
	return symlinks;
}

function findMissingWeights(): string[] {
	const missing: string[] = [];
	for (const rel of WEIGHTS_FILES) {
		const abs = resolve(PROJECT_ROOT, rel);
		try {
			const stat = lstatSync(abs);
			if (!stat.isFile()) {
				missing.push(rel);
			}
		} catch {
			missing.push(rel);
		}
	}
	return missing;
}

// ---- Guard 3: Release commands ----
const RELEASE_PATTERNS = [
	/\byarn\s+release\b/,
	/\bnpm\s+publish\b/,
	/\bnode\s+scripts\/publish-workspace\.mjs\b/,
	/\bnode\s+scripts\/copy-weights\.mjs\b/,
];

function isReleaseCommand(command: string): boolean {
	return RELEASE_PATTERNS.some((p) => p.test(command));
}

function touchesWeightsDir(command: string): boolean {
	return /neural-weights/.test(command);
}

// ---- Extension ----
export default function (pi: ExtensionAPI) {
	// Guard 4: Wrapped bash tool with MAILWOMAN_ROOT env
	const bashTool = createBashTool(PROJECT_ROOT, {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: { ...env, MAILWOMAN_ROOT: PROJECT_ROOT },
		}),
	});

	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});

	// Combined guard: protected-paths + symlink-check + release pre-flight
	pi.on("tool_call", async (event, ctx) => {
		// --- Guard 1: Protected paths ---
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = event.input.path as string | undefined;
			if (path && isPathProtected(path)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Path "${path}" is release-critical and protected in non-interactive mode` };
				}

				const choice = await ctx.ui.select(
					`⚠️  Protected path: ${path}\n\nThis file is release-critical. Allow write?`,
					["No, block it", "Yes, I know what I'm doing"],
				);

				if (!choice || choice.startsWith("No")) {
					return { block: true, reason: `Blocked write to protected path: ${path}` };
				}
			}
		}

		// --- Guards 2 & 3: Bash commands ---
		if (event.toolName === "bash") {
			const command = (event.input as { command?: string }).command ?? "";

			// --- Guard 2: Symlink detection on weights-dir commands ---
			if (touchesWeightsDir(command)) {
				const symlinks = findSymlinkedWeights();
				if (symlinks.length > 0) {
					if (!ctx.hasUI) {
						return {
							block: true,
							reason: `Symlinked weights detected: ${symlinks.join(", ")}. Blocked in non-interactive mode.`,
						};
					}

					const choice = await ctx.ui.select(
						`⚠️  Symlinked weight files detected:\n  ${symlinks.join("\n  ")}\n\nThese will break npm publish. Proceed?`,
						["No, block it", "Yes, proceed anyway"],
					);

					if (!choice || choice.startsWith("No")) {
						return { block: true, reason: "Blocked due to symlinked weights" };
					}
				}
			}

			// --- Guard 3: Release pre-flight ---
			if (isReleaseCommand(command)) {
				// Git status check
				const { stdout: gitStatus, code: gitCode } = await pi.exec("git", [
					"status",
					"--porcelain",
				]);

				const notRepo = gitCode !== 0;
				const hasChanges = !notRepo && gitStatus.trim().length > 0;
				const changedFileCount = hasChanges
					? gitStatus.trim().split("\n").filter(Boolean).length
					: 0;

				// Weights existence check
				const missingWeights = findMissingWeights();

				// Build issues list
				const issues: string[] = [];
				if (notRepo) issues.push("Not a git repository");
				if (hasChanges) issues.push(`${changedFileCount} uncommitted file(s)`);
				if (missingWeights.length > 0)
					issues.push(`Missing weights: ${missingWeights.join(", ")}`);

				if (!ctx.hasUI) {
					if (issues.length > 0) {
						return {
							block: true,
							reason: `Release pre-flight failed: ${issues.join("; ")}`,
						};
					}
					// Non-interactive with clean pre-flight: allow
					return undefined;
				}

				if (issues.length > 0) {
					const choice = await ctx.ui.select(
						`⚠️  Release pre-flight issues:\n  ${issues.join("\n  ")}\n\nProceed with release anyway?`,
						["No, abort", "Yes, proceed anyway"],
					);
					if (!choice || choice.startsWith("No")) {
						return { block: true, reason: `Release blocked: ${issues.join("; ")}` };
					}
				} else {
					const choice = await ctx.ui.select(
						"✅  Release pre-flight passed.\n  • git: clean\n  • weights: all present\n\nProceed with release?",
						["Yes, release", "No, abort"],
					);
					if (!choice || choice.startsWith("No")) {
						return { block: true, reason: "Release aborted by user" };
					}
				}
			}
		}

		return undefined;
	});
}
