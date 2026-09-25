/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 * Checks the local export and quantization packages against the training-image pins before local quantization.
 */

import { pathExists, readLocalTextFile } from "@mailwoman/core/fs/readers"
import { runFileSync } from "@mailwoman/core/process"

import { $public } from "#env"

const PYTHON = $public.PYTHON ?? "corpus-python/.venv/bin/python"
const TRAIN_REMOTE = "corpus-python/launch/app.py"

if (!(await pathExists(PYTHON))) {
	console.error(`✗ ${PYTHON} not found — create the corpus-python venv first`)

	process.exit(2)
}

/**
 * Lists the packages local quantization requires.
 * Other pinned packages may be absent locally.
 */
const QUANT_PKGS = new Set(["onnx", "onnxruntime"])

/**
 * Reads the pinned package versions from the training-image source.
 */
async function pinnedVersions(): Promise<Array<[string, string]>> {
	const src = await readLocalTextFile(TRAIN_REMOTE)
	const matches = src.matchAll(/"(torch|transformers|onnx|onnxruntime|onnxscript)==([0-9.]+)"/g)

	return [...matches].map((m) => [m[1], m[2]] as [string, string])
}

/**
 * Returns the installed version of a Python package, or `MISSING` when it is not installed.
 */
function installedVersion(pkg: string): string {
	try {
		// Stderr is ignored so a missing package prints no traceback.
		return runFileSync(PYTHON, ["-c", `import importlib.metadata as m; print(m.version('${pkg}'))`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return "MISSING"
	}
}

let fail = false

for (const [pkg, pinned] of await pinnedVersions()) {
	const actual = installedVersion(pkg)

	if (actual === pinned) {
		console.error(`✓ ${pkg} ${actual}`)
	} else if (actual === "MISSING" && !QUANT_PKGS.has(pkg)) {
		console.error(`⚠ ${pkg}: not installed locally (export-side; required on Modal, fine here)`)
	} else {
		console.error(`✗ ${pkg}: local=${actual} pinned=${pinned}`)

		fail = true
	}
}

if (fail) {
	console.error("")
	console.error(`Toolchain drift vs ${TRAIN_REMOTE} — do NOT quantize for release with this env.`)

	process.exit(1)
}

console.error("toolchain matches the pinned training-image set")
