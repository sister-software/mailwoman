/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Verify the LOCAL export/quant toolchain matches the pinned training-image set (#480).
 *
 *   Why this exists: the set was once unpinned (`>=`) and drifted between v0.9.3 and v0.9.7, silently
 *   breaking int8 quant for Safari WebGPU (the value_info/opset incident — see
 *   project-v4.1.0-release + the pinned block in scripts/modal/train_remote.py, which is the SOURCE
 *   OF TRUTH this script reads). Run before any local quantize; CI-able (exit 1 on mismatch). A
 *   bumped dep here is never a free upgrade — it must re-prove the Safari int8 graph (opset <= 17,
 *   value_info strip) end to end.
 *
 *   Plain-node tool-script (no env banner, no zx). Run: node scripts/verify-export-quant-versions.ts
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"

const PYTHON = process.env.PYTHON ?? "corpus-python/.venv/bin/python"
const TRAIN_REMOTE = "scripts/modal/train_remote.py"

if (!existsSync(PYTHON)) {
	console.error(`✗ ${PYTHON} not found — create the corpus-python venv first`)
	process.exit(2)
}

/**
 * Local quantize needs only the QUANT subset (onnx, onnxruntime) — export runs on Modal, where the
 * full image pins apply. Export-side packages absent locally are a WARNING; present-but-mismatched
 * is a FAILURE either way (a wrong version is worse than a missing one).
 */
const QUANT_PKGS = new Set(["onnx", "onnxruntime"])

/** Read the pinned `"pkg==1.2.3"` literals straight out of the Modal training-image source of truth. */
function pinnedVersions(): Array<[string, string]> {
	const src = readFileSync(TRAIN_REMOTE, "utf8")
	const matches = src.matchAll(/"(torch|transformers|onnx|onnxruntime|onnxscript)==([0-9.]+)"/g)
	return [...matches].map((m) => [m[1], m[2]] as [string, string])
}

function installedVersion(pkg: string): string {
	try {
		// stderr → "ignore" mirrors the bash `2>/dev/null`: a not-installed package throws
		// PackageNotFoundError with a noisy traceback we deliberately swallow (it's the MISSING path).
		return execFileSync(PYTHON, ["-c", `import importlib.metadata as m; print(m.version('${pkg}'))`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim()
	} catch {
		return "MISSING"
	}
}

let fail = false
for (const [pkg, pinned] of pinnedVersions()) {
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
