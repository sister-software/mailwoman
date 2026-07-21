/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Storybook coverage for `useDemoRuntime` — a small `<DemoRuntimeInspector>` renders the hook's state
 *   over a FAKE injected loader (no network, no ONNX, no httpvfs). The `Interactive` story lets you
 *   switch versions + toggle WASM and watch the load state machine drive; `SlowLoad` adds artificial
 *   latency so the staged loading state is visible; `AssetError` exercises the failure branch.
 */

import type { Meta, StoryObj } from "@storybook/react-vite"

import type { DemoAssetsLoadContext, DemoManifest, DemoReleaseBase } from "./useDemoRuntime.ts"
import { useDemoRuntime } from "./useDemoRuntime.ts"

interface StoryRelease extends DemoReleaseBase {
	modelSize: string
}

interface StoryAssets {
	loadedVersion: string
	forcedWASM: boolean
}

const MANIFEST: DemoManifest<StoryRelease> = {
	defaultVersion: "v7.2.0",
	releases: [
		{ version: "v7.2.0", label: "v7.2.0 (latest)", modelSize: "28 MB" },
		{ version: "v7.1.0", label: "v7.1.0", modelSize: "27 MB" },
		{ version: "v6.4.0", label: "v6.4.0", modelSize: "26 MB" },
	],
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeLoaders(delayMs: number, fail: boolean) {
	const loadManifest = async (): Promise<DemoManifest<StoryRelease>> => {
		await sleep(delayMs)

		return MANIFEST
	}

	const loadAssets = async (release: StoryRelease, ctx: DemoAssetsLoadContext): Promise<StoryAssets> => {
		ctx.setProgress(`Loading ${release.version} model (~${release.modelSize})…`)
		ctx.setStepLabels(["Loading classifier", "Loading FST gazetteer", "Loading WOF database"])

		await sleep(delayMs)

		if (ctx.signal.aborted) return { loadedVersion: release.version, forcedWASM: ctx.forceWASM }
		ctx.setBackend(ctx.forceWASM ? "wasm (28 MB int8)" : "webgpu (28 MB int8)")
		ctx.setStepIndex(0)

		await sleep(delayMs)
		ctx.setStepIndex(1)

		await sleep(delayMs)

		if (fail) throw new Error("Failed to open WOF database (simulated)")
		ctx.setStepIndex(2)

		return { loadedVersion: release.version, forcedWASM: ctx.forceWASM }
	}

	return { loadManifest, loadAssets }
}

function DemoRuntimeInspector({ delayMs = 0, fail = false }: { delayMs?: number; fail?: boolean }) {
	const { loadManifest, loadAssets } = makeLoaders(delayMs, fail)
	const rt = useDemoRuntime<StoryAssets, StoryRelease>({ loadManifest, loadAssets })

	return (
		<div style={{ fontFamily: "var(--ifm-font-family-monospace, monospace)", maxWidth: 520, display: "grid", gap: 8 }}>
			<div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
				<label>
					Version{" "}
					<select
						value={rt.selectedVersion ?? ""}
						onChange={(e) => rt.selectVersion(e.target.value)}
						disabled={!rt.manifest}
					>
						{rt.manifest?.releases.map((r) => (
							<option key={r.version} value={r.version}>
								{r.label}
							</option>
						))}
					</select>
				</label>
				<label>
					<input type="checkbox" checked={rt.forceWASM} onChange={(e) => rt.setForceWASM(e.target.checked)} /> Force
					WASM
				</label>
			</div>

			<table style={{ borderCollapse: "collapse", width: "100%" }}>
				<tbody>
					{(
						[
							["ready", String(rt.ready)],
							["selectedVersion", rt.selectedVersion ?? "—"],
							["loadedVersion", rt.assets?.loadedVersion ?? "—"],
							["forcedWASM", rt.assets ? String(rt.assets.forcedWASM) : "—"],
							["activeBackend", rt.activeBackend || "—"],
							["loadingProgress", rt.loadingProgress || "—"],
							["step", `${rt.loadingStepIndex} — ${rt.loadingStepLabels[rt.loadingStepIndex] ?? "—"}`],
							["errorMessage", rt.errorMessage ?? "—"],
						] as const
					).map(([k, v]) => (
						<tr key={k}>
							<td style={{ padding: "2px 8px", opacity: 0.7, borderBottom: "1px solid #8884" }}>{k}</td>
							<td style={{ padding: "2px 8px", borderBottom: "1px solid #8884" }}>{v}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

const meta: Meta<typeof DemoRuntimeInspector> = {
	title: "Runtime/useDemoRuntime",
	component: DemoRuntimeInspector,
}

export default meta
type Story = StoryObj<typeof DemoRuntimeInspector>

/** Instant fake loader — flip versions / WASM and watch the bundle reload. */
export const Interactive: Story = { args: { delayMs: 0 } }

/** Artificial latency so the staged loading + progress state is visible. */
export const SlowLoad: Story = { args: { delayMs: 600 } }

/** The asset-load failure branch — `errorMessage` set, `ready` stays false. */
export const AssetError: Story = { args: { delayMs: 200, fail: true } }
