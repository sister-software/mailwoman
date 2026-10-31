/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { workspacePath } from "@mailwoman/core/paths"
import { runFile, spawnProcessSync } from "@mailwoman/core/process"
import { expect, test } from "vitest"

/**
 * A Rust panic inside an export reaches Node as a thrown `Error` only
 * because every export uses `catch_unwind`.
 *
 * Without it the panic cannot unwind out of the napi callback and the runtime
 * aborts the process with `SIGABRT`.
 * The child process loads an addon built with the `panic-probe` feature.
 * That feature adds an export that panics.
 */
test("a panic in an mtf-node export throws in JavaScript and leaves the process running", async () => {
	const targetDir = workspacePath("mtf", "target", "panic-probe")

	await runFile(
		"cargo",
		[
			"build",
			"--profile",
			"node",
			"--locked",
			"-p",
			"mtf-node",
			"--features",
			"panic-probe",
			"--target-dir",
			targetDir,
		],
		{ cwd: workspacePath("mtf"), maxBuffer: 1 << 30 }
	)

	const script = [
		"const module = { exports: {} }",
		"process.dlopen(module, process.argv[1])",
		"try { module.exports.panicForTest('probe'); console.log('returned') }",
		"catch (error) { console.log('threw ' + error.message) }",
	].join("\n")

	const addon = workspacePath("mtf", "target", "panic-probe", "node", "libmtf_node.so")
	const child = spawnProcessSync(process.execPath, ["-e", script, addon])

	expect({ status: child.status, signal: child.signal, stdout: child.stdout.trim() }).toEqual({
		status: 0,
		signal: null,
		stdout: "threw probe",
	})
}, 1_800_000)
