/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The CLI weights guard (plan 3): wraps model-requiring commands the way a router AuthGuard wraps
 *   routes. Probes weight resolution; when weights are absent on an interactive stdin, offers a
 *   one-keystroke download into the user weights cache (`~/.cache/mailwoman/weights`, an npm prefix
 *   populated by the user's own `npm install` — integrity, proxy, and registry config for free).
 *
 *   Outcomes handed to the render prop:
 *
 *   - `"neural"` — weights resolve (pre-existing, or just downloaded); render the real command.
 *   - `"declined"` — the user said no, the download failed, or `--degraded` was passed; the caller
 *       renders its degraded (encoder-less) mode.
 *   - `"unavailable"` — weights absent + non-interactive stdin and no flag; the caller keeps its
 *       legacy fallback chain (pre-v7 behavior contract).
 *
 *   Installs `@latest` rather than pinning the CLI version: resolving `mailwoman/package.json` from
 *   both the source and compiled trees is the `__isCompiledTree` trap, and the post-install probe
 *   already catches the metadata-only-tarball case. The durable pin is the `weights-latest` dist-tag
 *   (board issue filed with this plan).
 */

import { spawn } from "node:child_process"

import { Spinner } from "@inkjs/ui"
import { resolveWeights, weightsCacheDir, weightsPackageName } from "@mailwoman/neural/weights"
import { Box, Text, useInput, useStdin } from "ink"
import React, { useEffect, useState } from "react"

/** How the guard resolved, handed to the render prop. */
export type WeightsOutcome = "neural" | "declined" | "unavailable"

/** Probe whether weights resolve for a locale without loading the model. Cheap (fs checks only). */
export function probeWeights(locale?: string, cacheRoot?: string): { ok: boolean; detail?: string } {
	try {
		resolveWeights({ locale, ...(cacheRoot ? { cacheRoot } : {}) })

		return { ok: true }
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error) }
	}
}

/** The npm invocation that populates the weights cache. Pure — unit-tested; `spec` defaults to `latest`. */
export function buildWeightsInstallArgs(locale: string | undefined, cacheRoot: string, spec = "latest"): string[] {
	return [
		"install",
		"--prefix",
		cacheRoot,
		"--no-audit",
		"--no-fund",
		"--loglevel",
		"error",
		`${weightsPackageName(locale)}@${spec}`,
	]
}

export interface DownloadWeightsOpts {
	locale?: string
	cacheRoot?: string
}

/**
 * Install the weights package into the cache prefix via the user's own npm (spawned as our own child; no pattern kills
 * anywhere near this). Success = npm exits 0 AND the post-install probe resolves — a metadata-only tarball (code-only
 * release) installs "successfully" but carries no binaries, and must report as a failure with an actionable message.
 */
export function downloadWeights(
	opts: DownloadWeightsOpts,
	onStatus?: (line: string) => void
): Promise<{ ok: boolean; message: string }> {
	const cacheRoot = opts.cacheRoot ?? weightsCacheDir()
	const packageName = weightsPackageName(opts.locale)

	onStatus?.(`Installing ${packageName} into ${cacheRoot} …`)

	return new Promise((resolvePromise) => {
		const child = spawn("npm", buildWeightsInstallArgs(opts.locale, cacheRoot), { stdio: ["ignore", "pipe", "pipe"] })
		const stderrChunks: string[] = []

		child.stdout.on("data", (chunk: Buffer) => onStatus?.(chunk.toString().trim()))
		child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString()))

		child.on("error", (error) => {
			resolvePromise({ ok: false, message: `Could not run npm: ${error.message}` })
		})

		child.on("close", (code) => {
			if (code !== 0) {
				resolvePromise({
					ok: false,
					message: `npm install exited ${code}:\n${stderrChunks.join("").trim() || "(no stderr)"}`,
				})

				return
			}

			const probe = probeWeights(opts.locale, cacheRoot)

			if (!probe.ok) {
				resolvePromise({
					ok: false,
					message:
						`${packageName} installed but carries no model binaries — most likely a code-only release ` +
						`tarball. Try again after the next model release, or install a known model version, e.g. ` +
						`npm install --prefix ${cacheRoot} ${packageName}@6.0.0`,
				})

				return
			}

			resolvePromise({ ok: true, message: `Weights ready in ${cacheRoot}.` })
		})
	})
}

export interface WeightsGuardProps {
	/** Locale whose weights package guards this command (defaults to en-US resolution rules). */
	locale?: string
	/** `--download-weights`: skip the prompt, download immediately. */
	autoDownload?: boolean
	/** `--degraded`: skip the prompt, hand the caller the declined outcome directly. */
	forceDegraded?: boolean
	/** Test seam / non-default cache root. */
	cacheRoot?: string
	/** Renders once the guard settles. */
	children: (outcome: WeightsOutcome) => React.ReactElement
}

type GuardPhase =
	| { phase: "prompt" }
	| { phase: "downloading"; status: string }
	| { phase: "settled"; outcome: WeightsOutcome }

/**
 * Interactive guard around model-requiring commands. See the module docstring for the outcome contract. The prompt
 * renders only on a raw-mode-capable stdin; everything else settles immediately without painting UI.
 */
export function WeightsGuard({
	locale,
	autoDownload,
	forceDegraded,
	cacheRoot,
	children,
}: WeightsGuardProps): React.ReactElement {
	const { isRawModeSupported } = useStdin()

	const [state, setState] = useState<GuardPhase>(() => {
		if (forceDegraded) return { phase: "settled", outcome: "declined" }

		if (probeWeights(locale, cacheRoot).ok) return { phase: "settled", outcome: "neural" }

		if (autoDownload) return { phase: "downloading", status: "Starting download…" }

		return isRawModeSupported ? { phase: "prompt" } : { phase: "settled", outcome: "unavailable" }
	})

	const downloading = state.phase === "downloading"

	useEffect(() => {
		if (!downloading) return

		let cancelled = false

		void downloadWeights({ locale, cacheRoot }, (line) => {
			if (cancelled) return

			setState((prior) => (prior.phase === "downloading" ? { phase: "downloading", status: line } : prior))
		}).then((result) => {
			if (cancelled) return

			if (!result.ok) {
				// Stderr so the message survives Ink's re-render when the degraded output paints.
				console.error(result.message)
			}

			setState({ phase: "settled", outcome: result.ok ? "neural" : "declined" })
		})

		return () => {
			cancelled = true
		}
	}, [downloading, locale, cacheRoot])

	useInput(
		(input, key) => {
			if (input === "n" || input === "N" || key.escape) {
				setState({ phase: "settled", outcome: "declined" })
			} else if (input === "y" || input === "Y" || key.return) {
				setState({ phase: "downloading", status: "Starting download…" })
			}
		},
		{ isActive: state.phase === "prompt" }
	)

	switch (state.phase) {
		case "settled":
			return children(state.outcome)
		case "prompt":
			return (
				<Box flexDirection="column">
					<Text>
						Neural weights for <Text bold>{locale ?? "en-US"}</Text> aren&apos;t installed.
					</Text>
					<Text>
						Download <Text bold>{weightsPackageName(locale)}</Text> to{" "}
						<Text dimColor>{cacheRoot ?? weightsCacheDir()}</Text>? <Text bold>[Y/n]</Text>
					</Text>
				</Box>
			)
		case "downloading":
			return (
				<Box>
					<Spinner />
					<Text> {state.status}</Text>
				</Box>
			)
	}
}
