/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Direct hook test for `useDemoRuntime` — driven through a tiny harness with a FAKE injected loader
 *   (no network, no ONNX, no httpvfs). Exercises the state machine: mount → manifest → default version
 *   → assets → ready; a version switch reloads the bundle; `forceWASM` reloads with the flag set; a
 *   rejecting `loadAssets` surfaces `errorMessage` and keeps `ready` false; and the staged
 *   progress/step channel is reported through `ctx`.
 */

import { userEvent } from "@vitest/browser/context"
import type { ReactNode } from "react"
import { expect, test, vi } from "vitest"

import { renderComponent } from "../test/render.tsx"
import type { DemoAssetsLoadContext, DemoManifest, DemoReleaseBase } from "./useDemoRuntime.ts"
import { useDemoRuntime } from "./useDemoRuntime.ts"

interface TestRelease extends DemoReleaseBase {
	modelSize: string
}

interface TestAssets {
	loadedVersion: string
	forcedWASM: boolean
}

const MANIFEST: DemoManifest<TestRelease> = {
	defaultVersion: "v2",
	releases: [
		{ version: "v1", label: "v1 (old)", modelSize: "10 MB" },
		{ version: "v2", label: "v2 (default)", modelSize: "20 MB" },
	],
}

// Stable module-level loaders so the harness passes the same closures every render.
const loadManifest = async (): Promise<DemoManifest<TestRelease>> => MANIFEST

const loadAssetsOK = async (release: TestRelease, ctx: DemoAssetsLoadContext): Promise<TestAssets> => {
	ctx.setProgress(`Loading ${release.version} (~${release.modelSize})…`)
	ctx.setStepLabels(["Loading classifier", "Loading gazetteer"])
	ctx.setBackend(ctx.forceWASM ? "wasm" : "webgpu")
	ctx.setStepIndex(0)
	ctx.setStepIndex(1)

	return { loadedVersion: release.version, forcedWASM: ctx.forceWASM }
}

const loadAssetsFail = async (): Promise<TestAssets> => {
	throw new Error("asset boom")
}

function Harness({
	manifestLoader = loadManifest,
	assetLoader = loadAssetsOK,
}: {
	manifestLoader?: () => Promise<DemoManifest<TestRelease> | null>
	assetLoader?: (release: TestRelease, ctx: DemoAssetsLoadContext) => Promise<TestAssets>
}): ReactNode {
	const rt = useDemoRuntime<TestAssets, TestRelease>({
		loadManifest: manifestLoader,
		loadAssets: assetLoader,
	})

	return (
		<div>
			<span className="version">{rt.selectedVersion ?? "none"}</span>
			<span className="ready">{rt.ready ? "yes" : "no"}</span>
			<span className="assets-version">{rt.assets?.loadedVersion ?? ""}</span>
			<span className="assets-wasm">{rt.assets ? String(rt.assets.forcedWASM) : ""}</span>
			<span className="backend">{rt.activeBackend}</span>
			<span className="progress">{rt.loadingProgress}</span>
			<span className="step">{rt.loadingStepIndex}</span>
			<span className="steplabels">{rt.loadingStepLabels.join("|")}</span>
			<span className="error">{rt.errorMessage ?? ""}</span>
			<span className="release-label">{rt.selectedRelease?.label ?? ""}</span>
			<button type="button" className="pick-v1" onClick={() => rt.selectVersion("v1")}>
				v1
			</button>
			<button type="button" className="force-wasm" onClick={() => rt.setForceWASM(true)}>
				wasm
			</button>
		</div>
	)
}

const text = (container: HTMLElement, selector: string) => container.querySelector(selector)?.textContent ?? ""

test("mount → manifest → default version → assets → ready", async () => {
	const { container } = renderComponent(<Harness />)

	await vi.waitFor(() => expect(text(container, ".ready")).toBe("yes"), { timeout: 2000 })

	expect(text(container, ".version")).toBe("v2")
	expect(text(container, ".assets-version")).toBe("v2")
	expect(text(container, ".backend")).toBe("webgpu")
	expect(text(container, ".progress")).toBe("") // cleared on success
	expect(text(container, ".step")).toBe("1") // last reported step
	expect(text(container, ".steplabels")).toBe("Loading classifier|Loading gazetteer")
	expect(text(container, ".release-label")).toBe("v2 (default)")
	expect(text(container, ".error")).toBe("")
})

test("selectVersion reloads the bundle for the new version", async () => {
	const { container } = renderComponent(<Harness />)
	await vi.waitFor(() => expect(text(container, ".assets-version")).toBe("v2"), { timeout: 2000 })

	await userEvent.click(container.querySelector(".pick-v1") as HTMLButtonElement)

	await vi.waitFor(() => expect(text(container, ".assets-version")).toBe("v1"), { timeout: 2000 })
	expect(text(container, ".version")).toBe("v1")
	expect(text(container, ".ready")).toBe("yes")
})

test("setForceWASM reloads with the WASM flag set", async () => {
	const { container } = renderComponent(<Harness />)
	await vi.waitFor(() => expect(text(container, ".ready")).toBe("yes"), { timeout: 2000 })
	expect(text(container, ".assets-wasm")).toBe("false")

	await userEvent.click(container.querySelector(".force-wasm") as HTMLButtonElement)

	await vi.waitFor(() => expect(text(container, ".assets-wasm")).toBe("true"), { timeout: 2000 })
	expect(text(container, ".backend")).toBe("wasm")
})

test("a rejecting loadAssets surfaces errorMessage and stays not-ready", async () => {
	const { container } = renderComponent(<Harness assetLoader={loadAssetsFail} />)

	await vi.waitFor(() => expect(text(container, ".error")).toBe("asset boom"), { timeout: 2000 })
	expect(text(container, ".ready")).toBe("no")
	expect(text(container, ".assets-version")).toBe("")
	expect(text(container, ".progress")).toBe("") // cleared even on failure
})

test("a null manifest leaves nothing selected and never readies", async () => {
	const nullManifest = async () => null
	const { container } = renderComponent(<Harness manifestLoader={nullManifest} />)

	// Give the mount effect a tick; the version stays unselected and the bundle never loads.
	await vi.waitFor(() => expect(text(container, ".version")).toBe("none"), { timeout: 2000 })
	expect(text(container, ".ready")).toBe("no")
})
