# Earth Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private workspace, `packages/earth`, that builds a React + Vite installable PWA for Cloudflare Workers Static Assets, mounts the geocoder UI from `@mailwoman/react/map` on a fake runtime, serves `/`, `/debug`, `/trace` and `/build.json`, and is ready for a Workers Builds project at `earth.mailwoman.ai`. No real runtime moves in this plan; that is the second Earth plan.

**Architecture:** One Vite app with three client routes read from `location.pathname`, no router. `vite-plugin-pwa` in `injectManifest` mode owns the manifest and a precache-only service worker that the runtime plan later extends with the range cache. A small Vite plugin emits `build.json` from `@mailwoman/core/git`. The plugin, the PWA identity and the Playwright preview config live in `packages/site-kit`, a private workspace the planetary app imports too, so neither app writes them twice. `wrangler.toml` declares `assets` and no `main`. The fake runtime the app mounts is the one `@mailwoman/react`'s stories and tests already use, moved from a test helper to a public subpath so nothing is copied.

**Tech Stack:** React 19, Vite 8, `vite-plugin-pwa` 1.3 (workbox 7), `react-map-gl` 8 over MapLibre 6, wrangler 4, Playwright for the browser smoke, vitest for the pure modules.

**Spec:** `docs/superpowers/specs/2026-09-06-earth-app-design.md` (sections Workspace, Build and deployment, PWA, Routes, Origins and CORS, Testing). The move map and the docs removal are the second plan.

## Global Constraints

- The app is `private: true`, lives under `packages/`, and joins the root `workspaces` array, both root `tsconfig.json` reference entries, and `SANCTIONED_RELEASE_ABSENCES` with a stated reason. The `publishCount` pin in `packages/release-kit/test/integration/release-stage.test.ts` stays at 60.
- No application Worker script: `wrangler.toml` has no `main`, no `run_worker_first`, no routes.
- Dependency ranges match the workspace that already declares them (`sherif` in `health:manifests` refuses a second range): `react` and `react-dom` `^19.2.8`, `react-map-gl` `^8.1.3`, `maplibre-gl` `^6.7.0`, `vite` `^8.2.2`, `@vitejs/plugin-react` `^6.1.1`, `wrangler` `^4.129.0`, `@playwright/test` at the range `docs/package.json` carries.
- `process.env` is never read directly; there is no environment to read in this plan.
- A test imports the package under test through its public exports; the app declares an `exports` entry for every module a test names.
- Source under `lib/`, tests under `test/`, `rootDir: ./lib`, explicit `.ts`/`.tsx` extensions on relative imports, no `enum`.
- Comments state invariants, not history.
- Every commit passes the pre-commit hook. Branch: `git fetch origin main && git checkout -b feat/earth-shell origin/main`.
- Nothing in `docs/` changes in this plan except the three-origin CORS edit in the tile worker, which is not in `docs/`.

## File Structure

```text
packages/earth/
  package.json            @mailwoman/earth, private, scripts dev/build/preview/test:browser/deploy:dry-run
  tsconfig.json           extends @sister.software/tsconfig/web, rootDir ./lib
  tsconfig.test.json      extends ../../tsconfig.test-base.json, adds test/, vite.config.ts, playwright.config.ts
  vite.config.ts          react(), installablePWA(), buildInfoPlugin() from site-kit
  wrangler.toml           assets only
  playwright.config.ts    previewConfig() from site-kit
  index.html
  README.md               what the app is, the Workers Builds settings table
  public/
    icon.svg, icon-192.png, icon-512.png
  lib/
    main.tsx              createRoot + service-worker registration
    App.tsx               route → view
    routes.ts             routeForPath, queryFromSearch            (pure; tested)
    config.ts             the three production origins             (pure)
    service-worker.ts     precacheAndRoute(self.__WB_MANIFEST)
  test/
    unit/routes.test.ts
    browser/shell.spec.ts

packages/site-kit/                        @mailwoman/site-kit, private: the static-site build conventions both apps share
  lib/build-info.ts                       BuildInfo type, renderBuildInfo                       (pure; tested)
  lib/vite/build-info.ts                  buildInfoPlugin({ app }) — emits build.json
  lib/vite/pwa.ts                         installablePWA({ id, name, shortName, themeColor }) — VitePWA options
  lib/playwright.ts                       previewConfig({ port, remoteURLVariable }) — the Playwright config both apps use
  test/unit/build-info.test.ts

packages/react/lib/map/fake-runtime.ts    moved from packages/react/test/mocks.tsx (the DemoRuntime half)
packages/react/package.json                exports "./map/fake-runtime"
packages/tile-worker/lib/cors.ts           + earth, moon, mars origins
package.json, tsconfig.json, packages/release-kit/lib/release/stage.ts, dependency-cruiser.config.cjs, .github/workflows/test.yml
```

---

### Task 1: The fake runtime becomes a public subpath of `@mailwoman/react`

**Files:**

- Create: `packages/react/lib/map/fake-runtime.ts`
- Modify: `packages/react/test/mocks.tsx` (remove `STUB_MAP_STYLE`, `FAKE_SUGGESTIONS`, `makeDemoRuntime`, `makeFakeParseResult`, `makePipelineRuntime`; keep the POI fakes)
- Modify: `packages/react/package.json` (`exports["./map/fake-runtime"]`)
- Modify: the eight consumers: `lib/map/GeocoderDemo.stories.tsx`, `lib/map/PlaceAutocomplete.stories.tsx`, `lib/map/ResultPanel.stories.tsx`, `lib/pipeline/PipelineExplorer.stories.tsx`, `test/unit/map/panels.test.tsx`, `test/unit/map/GeocoderDemo.test.tsx`, `test/unit/pipeline/PipelineExplorer.test.tsx`, `test/mocks.tsx`

**Interfaces:**

- Produces: `@mailwoman/react/map/fake-runtime` exporting `STUB_MAP_STYLE: DemoMapStyle`, `FAKE_SUGGESTIONS: Suggestion[]`, `makeFakeParseResult(input?: string): ParseResult`, `makePipelineRuntime(overrides?: Partial<PipelineRuntime>): PipelineRuntime`, `makeDemoRuntime(overrides?: Partial<DemoRuntime>): DemoRuntime`. Task 5 mounts `makeDemoRuntime()`.

The app cannot import `packages/react/test/mocks.tsx` (a test helper is private to its package's `test/`), and a copy in the app would be the duplicate this repository refuses. A fake runtime is a legitimate product surface: a host that wants the UI without the model mounts it.

- [ ] **Step 1: Create the module with the five moved definitions**

`packages/react/lib/map/fake-runtime.ts` carries, verbatim from `test/mocks.tsx`, `STUB_MAP_STYLE`, `FAKE_SUGGESTIONS`, `makeDemoRuntime`, `makeFakeParseResult` and `makePipelineRuntime`, with this header and these imports (package-internal, through the `#` map):

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   A fake geocoder runtime: canned parse + resolve, an offline stub map style, canned autocomplete, a version list.
 *   No network, no ONNX, no maplibre at run time — everything is data. It is what the stories and component tests
 *   mount, and what a host mounts to show the UI without the model.
 */

import type { ParseResult, PipelineRuntime } from "#pipeline/types"

import type { DemoMapStyle, DemoRuntime, Suggestion } from "#map/types"
import type { ResolvedMapPlace } from "#map/place-render"
```

`STUB_MAP_STYLE` and `FAKE_SUGGESTIONS` become `export const`. Check each type's home before committing: `ResolvedMapPlace` is exported from `#map/place-render`, `ParseResult` and `PipelineRuntime` from `#pipeline/types`, `DemoMapStyle`, `DemoRuntime` and `Suggestion` from `#map/types`; if `grep -n "export interface ParseResult" packages/react/lib/pipeline/types.ts` finds nothing, follow `packages/react/lib/index.ts` to where it is.

- [ ] **Step 2: Add the export**

In `packages/react/package.json`, beside `"./map/ResultPanel"`:

```json
"./map/fake-runtime": {
	"node": "./lib/map/fake-runtime.ts",
	"default": "./out/map/fake-runtime.js",
	"types": "./out/map/fake-runtime.d.ts"
},
```

- [ ] **Step 3: Point every consumer at the new home**

In `test/mocks.tsx`, delete the five moved definitions and the now-unused imports (`DemoMapStyle`, `DemoRuntime`, `ParseResult`, `PipelineRuntime`, `Suggestion`, `ResolvedMapPlace`). In the three `lib/**/*.stories.tsx` files replace `from "#test/mocks"` with `from "#map/fake-runtime"` for those names (a story that also uses a POI fake keeps its `#test/mocks` import for it). In the three `test/unit/**` files replace the same names' source with `from "@mailwoman/react/map/fake-runtime"`.

```bash
grep -rn "makeDemoRuntime\|makePipelineRuntime\|makeFakeParseResult\|FAKE_SUGGESTIONS\|STUB_MAP_STYLE" packages/react --include='*.ts' --include='*.tsx' | grep -v "/out/" | grep -v "fake-runtime.ts"
```

Expected: every hit imports from `#map/fake-runtime` (under `lib/`) or `@mailwoman/react/map/fake-runtime` (under `test/`).

- [ ] **Step 4: Verify**

```bash
yarn compile
yarn oxlint packages/react/lib/map/fake-runtime.ts packages/react/test/mocks.tsx
yarn workspace @mailwoman/react test:browser
yarn mwops health exports
```

Expected: the react browser suite passes with the same count as on `main`; knip reports nothing (the subpath has consumers).

- [ ] **Step 5: Commit**

```bash
git add packages/react
git commit -m "feat(react): the fake geocoder runtime is a public subpath, map/fake-runtime, not a test helper"
```

---

### Task 2: The `packages/earth` workspace and its registers

**Files:**

- Create: `packages/earth/package.json`, `packages/earth/tsconfig.json`, `packages/earth/tsconfig.test.json`, `packages/earth/README.md`
- Modify: `package.json` (root `workspaces`), `tsconfig.json` (root `references`), `packages/release-kit/lib/release/stage.ts` (`SANCTIONED_RELEASE_ABSENCES`), `dependency-cruiser.config.cjs` (the browser-package regex)

**Interfaces:**

- Produces: the workspace name `@mailwoman/earth` every later task's `yarn workspace` command uses.

- [ ] **Step 1: Write the manifest**

`packages/earth/package.json`:

```json
{
	"name": "@mailwoman/earth",
	"version": "1.0.0",
	"private": true,
	"description": "Earth — the mailwoman geocoder map at earth.mailwoman.ai: a React + Vite installable PWA on Cloudflare Workers Static Assets.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [
		{
			"name": "Teffen Ellis",
			"email": "teffen@sister.software"
		}
	],
	"type": "module",
	"imports": {
		"#*": {
			"node": "./lib/*.ts",
			"default": "./out/*.js",
			"types": "./out/*.d.ts"
		}
	},
	"exports": {
		"./package.json": "./package.json",
		"./routes": {
			"node": "./lib/routes.ts",
			"default": "./out/routes.js",
			"types": "./out/routes.d.ts"
		},
		"./config": {
			"node": "./lib/config.ts",
			"default": "./out/config.js",
			"types": "./out/config.d.ts"
		}
	},
	"scripts": {
		"dev": "vite",
		"build": "vite build",
		"preview": "vite preview --port 7780 --strictPort",
		"test:browser": "playwright test",
		"deploy:dry-run": "wrangler deploy --dry-run"
	},
	"dependencies": {
		"@mailwoman/core": "workspace:*",
		"@mailwoman/react": "workspace:*",
		"@mailwoman/site-kit": "workspace:*",
		"maplibre-gl": "^6.7.0",
		"react": "^19.2.8",
		"react-dom": "^19.2.8",
		"react-map-gl": "^8.1.3",
		"workbox-precaching": "^7.4.1"
	},
	"devDependencies": {
		"@playwright/test": "^1.63.0",
		"@types/react": "^19.2.18",
		"@types/react-dom": "^19.2.7",
		"@vitejs/plugin-react": "^6.1.1",
		"vite": "^8.2.2",
		"vite-plugin-pwa": "^1.3.0",
		"workbox-window": "^7.4.1",
		"wrangler": "^4.129.0"
	},
	"engines": {
		"node": ">=24.18.0"
	}
}
```

The ranges above are the ones `docs/package.json` and `packages/react/package.json` declare today; `sherif` refuses a range that differs from an existing declaration, so if either has moved by execution time, copy the current one. No workspace declares a `workbox-*` package yet, so `^7.4.1` (the plugin's peer range) is the first declaration.

- [ ] **Step 2: Write the two tsconfigs**

`packages/earth/tsconfig.json`:

```json
{
	"extends": "@sister.software/tsconfig/web",
	"compilerOptions": {
		"rootDir": "./lib",
		"outDir": "./out",
		"emitDeclarationOnly": false,
		"rewriteRelativeImportExtensions": true,
		"erasableSyntaxOnly": true,
		"types": ["vite/client", "vite-plugin-pwa/client"]
	},
	"include": ["./lib/**/*"],
	"exclude": ["./out/**/*", "./dist/**/*", "./test/**", "./vite.config.ts", "./playwright.config.ts"],
	"references": [{ "path": "../core" }, { "path": "../react" }, { "path": "../site-kit" }]
}
```

`packages/earth/tsconfig.test.json`:

```json
{
	"extends": ["./tsconfig.json", "../../tsconfig.test-base.json"],
	"include": ["./lib/**/*", "./test/**/*", "./vite.config.ts", "./playwright.config.ts"],
	"exclude": ["./out/**/*", "./dist/**/*"],
	"references": [{ "path": "./tsconfig.json" }]
}
```

Compare against `packages/license-worker/tsconfig.test.json` and copy any field it carries that these lack; the test-base file's header explains why `include`, `exclude` and `references` repeat per workspace.

- [ ] **Step 3: Register the workspace in the four registers**

Two workspaces register here: `packages/earth` and `packages/site-kit`. `packages/site-kit/package.json`:

```json
{
	"name": "@mailwoman/site-kit",
	"version": "1.0.0",
	"private": true,
	"description": "The static-site build conventions the Earth and planetary apps share: the build.json Vite plugin, the installable-PWA manifest options, the Playwright preview configuration.",
	"license": "AGPL-3.0-only OR LicenseRef-Commercial",
	"contributors": [{ "name": "Teffen Ellis", "email": "teffen@sister.software" }],
	"type": "module",
	"imports": { "#*": { "node": "./lib/*.ts", "default": "./out/*.js", "types": "./out/*.d.ts" } },
	"exports": {
		"./package.json": "./package.json",
		"./build-info": {
			"node": "./lib/build-info.ts",
			"default": "./out/build-info.js",
			"types": "./out/build-info.d.ts"
		},
		"./vite/build-info": {
			"node": "./lib/vite/build-info.ts",
			"default": "./out/vite/build-info.js",
			"types": "./out/vite/build-info.d.ts"
		},
		"./vite/pwa": { "node": "./lib/vite/pwa.ts", "default": "./out/vite/pwa.js", "types": "./out/vite/pwa.d.ts" },
		"./playwright": {
			"node": "./lib/playwright.ts",
			"default": "./out/playwright.js",
			"types": "./out/playwright.d.ts"
		}
	},
	"dependencies": {
		"@mailwoman/core": "workspace:*",
		"@playwright/test": "^1.63.0",
		"vite": "^8.2.2",
		"vite-plugin-pwa": "^1.3.0"
	},
	"engines": { "node": ">=24.18.0" }
}
```

with a `tsconfig.json` in the shape of `packages/tile-worker/tsconfig.json` (no workers types, reference `../core`) and a `tsconfig.test.json` in the shape of Task 2 Step 2's.

Root `package.json`: insert `"packages/earth"` (after `packages/dev-mcp`, before `packages/evidence`) and `"packages/site-kit"` (after `packages/sentencepiece-wasm`, before `packages/soil`) into `workspaces`.

Root `tsconfig.json`: add, next to the `tile-worker` and `license-worker` entries,

```json
		{ "path": "./packages/earth" },
		{ "path": "./packages/earth/tsconfig.test.json" },
		{ "path": "./packages/site-kit" },
		{ "path": "./packages/site-kit/tsconfig.test.json" },
```

`packages/release-kit/lib/release/stage.ts`, in `SANCTIONED_RELEASE_ABSENCES` after the `license-worker` line:

```ts
	"packages/earth": "private Earth map app — Cloudflare infrastructure, never publishes",
	"packages/site-kit": "private static-site build conventions for the Earth and planetary apps — never publishes",
```

`dependency-cruiser.config.cjs`, the `no-serve-package-to-build-tooling` rule's `from.path`:

```js
			from: { path: "^packages/(?:react|neural-web|tile-worker|api|fastify|mcp|earth)/" },
```

- [ ] **Step 4: Write the README**

`packages/earth/README.md`:

```markdown
# @mailwoman/earth

Earth is the mailwoman geocoder map, served at `https://earth.mailwoman.ai` as an installable PWA on Cloudflare
Workers Static Assets. The app is static: `wrangler.toml` declares `assets` and no Worker script, so a navigation or
an asset request never invokes compute. Model and gazetteer artifacts come from `public.mailwoman.ai` at run time
and tiles from `tiles.mailwoman.ai`.

## Commands

| Command                                          | Does                                                            |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `yarn workspace @mailwoman/earth dev`            | Vite dev server                                                 |
| `yarn workspace @mailwoman/earth build`          | `dist/`, with `build.json`, the manifest and the service worker |
| `yarn workspace @mailwoman/earth preview`        | serves `dist/` on port 7780 with SPA fallback                   |
| `yarn workspace @mailwoman/earth test:browser`   | the Playwright smoke over the preview server                    |
| `yarn workspace @mailwoman/earth deploy:dry-run` | validates `wrangler.toml` and the asset manifest                |

## Routes

`/` is the geocoder, `/debug` the same page with the debug drawer open, `/trace` the trace page. `?q=<address>` pre-fills
the query on all three. Cloudflare's SPA fallback serves `index.html` for each; the app reads `location.pathname`.

## Deployment: Workers Builds

Cloudflare builds and deploys this app from the repository; the settings live in the Cloudflare dashboard, not here.

| Setting           | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Root directory    | `packages/earth`                                             |
| Build command     | `yarn build`                                                 |
| Deploy command    | `npx wrangler deploy`                                        |
| Production branch | `main`                                                       |
| Watch paths       | `packages/earth/**`, `packages/react/**`, `packages/core/**` |

Yarn locates the project root by walking up from the root directory, so the install covers the workspace graph. If the
first build shows it does not, set the root directory to `.` and the build command to
`yarn workspace @mailwoman/earth build`, and point the wrangler configuration path at `packages/earth/wrangler.toml`.

The watch paths grow when the runtime moves in (`neural`, `resolver-wof-wasm`, `cartographer`, `spatial`).
```

- [ ] **Step 5: Install and check the registers**

```bash
yarn install
node -e "const w=require('./package.json').workspaces,r=require('./.release-it.json').plugins['@release-it-plugins/workspaces'].workspaces;console.log(w.filter(x=>!r.includes(x)))"
yarn vitest --run --config vitest.slow.config.ts packages/release-kit/test/integration/release-stage.test.ts
yarn mwops health manifest-targets
```

Expected: the absence list prints 15 names and includes `packages/earth` and `packages/site-kit`; `release-stage.test.ts` passes with `publishCount` 60; `manifest-targets` reports nothing (every `exports` target names a file Task 3 creates, so run this step again after Task 3 if it reports the three `lib/*.ts` files missing).

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock tsconfig.json packages/earth packages/site-kit packages/release-kit/lib/release/stage.ts dependency-cruiser.config.cjs
git commit -m "feat(earth,site-kit): the two private workspaces, registered in the four registers"
```

---

### Task 3: Routes and config in the app, build info in site-kit, test-first

**Files:**

- Create: `packages/earth/lib/routes.ts`, `packages/earth/lib/config.ts`, `packages/site-kit/lib/build-info.ts`
- Test: `packages/earth/test/unit/routes.test.ts`, `packages/site-kit/test/unit/build-info.test.ts`

**Interfaces:**

- Produces: `routeForPath(pathname: string): Route | null` with `Route = { Geocoder: "geocoder", Debug: "debug", Trace: "trace" }`; `queryFromSearch(search: string): string | null`; `EarthConfig` with `dataOriginURL`, `tileWorkerURL`, `basemapTileJSONURL` and `PRODUCTION_CONFIG`; `BuildInfo` and `renderBuildInfo(info): string`. Task 4's Vite plugin calls `renderBuildInfo`; Task 5's `App.tsx` calls `routeForPath` and `queryFromSearch`.

- [ ] **Step 1: Write the failing tests**

`packages/earth/test/unit/routes.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { Route, queryFromSearch, routeForPath } from "@mailwoman/earth/routes"
import { describe, expect, test } from "vitest"

describe("routeForPath", () => {
	test.each([
		["/", Route.Geocoder],
		["/debug", Route.Debug],
		["/trace", Route.Trace],
		["/debug/", Route.Debug],
		["", Route.Geocoder],
	])("%s → %s", (pathname, route) => {
		expect(routeForPath(pathname)).toBe(route)
	})

	test("an unknown path is null, not the geocoder", () => {
		expect(routeForPath("/demo")).toBeNull()
		expect(routeForPath("/debug/extra")).toBeNull()
	})
})

describe("queryFromSearch", () => {
	test("reads ?q= and decodes it", () => {
		expect(queryFromSearch("?q=3215%20SE%20Clinton%20St%20Portland%20OR")).toBe("3215 SE Clinton St Portland OR")
	})

	test("a missing or blank q is null", () => {
		expect(queryFromSearch("")).toBeNull()
		expect(queryFromSearch("?q=")).toBeNull()
		expect(queryFromSearch("?q=%20%20")).toBeNull()
		expect(queryFromSearch("?other=1")).toBeNull()
	})
})
```

`packages/site-kit/test/unit/build-info.test.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { renderBuildInfo } from "@mailwoman/site-kit/build-info"
import { expect, test } from "vitest"

test("renderBuildInfo emits the three fields as tab-indented JSON with a trailing newline", () => {
	const text = renderBuildInfo({ app: "mailwoman-earth", revision: "abc1234", buildTime: "2026-09-07T10:00:00Z" })
	// `app` is any string: the planetary builds write "mailwoman-moon" and "mailwoman-mars" through the same function.

	expect(JSON.parse(text)).toEqual({ app: "mailwoman-earth", revision: "abc1234", buildTime: "2026-09-07T10:00:00Z" })
	expect(text.endsWith("\n")).toBe(true)
})
```

- [ ] **Step 2: Run them to see the failure**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/earth/test/unit packages/site-kit/test/unit
```

Expected: both files fail to resolve `@mailwoman/earth/routes` and `@mailwoman/site-kit/build-info` (the root vitest config aliases every workspace's `exports` to source, so once the files exist the alias resolves).

- [ ] **Step 3: Write the three modules**

`packages/earth/lib/routes.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The app's three client routes, read from `location.pathname` with no router. Cloudflare's SPA fallback serves
 *   `index.html` for every path, so the app decides what a path means; a path it does not know is not the geocoder,
 *   it is a not-found view, so a stale link fails visibly.
 */

export const Route = {
	Geocoder: "geocoder",
	Debug: "debug",
	Trace: "trace",
} as const

export type Route = (typeof Route)[keyof typeof Route]

const ROUTES_BY_PATH: ReadonlyMap<string, Route> = new Map([
	["/", Route.Geocoder],
	["/debug", Route.Debug],
	["/trace", Route.Trace],
])

/**
 * The route a pathname names, with a trailing slash forgiven, or null for a path the app does not serve.
 */
export function routeForPath(pathname: string): Route | null {
	const normalized = pathname.replace(/\/+$/u, "") || "/"

	return ROUTES_BY_PATH.get(normalized) ?? null
}

/**
 * The `?q=` query, decoded, or null when absent or blank. Blank is null so a link that carries `?q=` with nothing after
 * it behaves like a link without it.
 */
export function queryFromSearch(search: string): string | null {
	const value = new URLSearchParams(search).get("q")

	if (value === null) return null

	return value.trim() === "" ? null : value
}
```

`packages/earth/lib/config.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The origins the app talks to. They are typed URLs rather than strings so a composed URL cannot lose its trailing
 *   slash, and a single object so a staging deployment can swap all three at once.
 */

export interface EarthConfig {
	/**
	 * The public, unauthenticated bucket every model and gazetteer artifact resolves against.
	 */
	dataOriginURL: URL
	/**
	 * The tile worker serving the basemap and overlay tiles.
	 */
	tileWorkerURL: URL
	/**
	 * The basemap's TileJSON, on the tile worker.
	 */
	basemapTileJSONURL: URL
}

export const PRODUCTION_CONFIG: EarthConfig = {
	dataOriginURL: new URL("https://public.mailwoman.ai/"),
	tileWorkerURL: new URL("https://tiles.mailwoman.ai/"),
	basemapTileJSONURL: new URL("https://tiles.mailwoman.ai/basemap-v4.json"),
}
```

`packages/site-kit/lib/build-info.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   `build.json`: the static deployment record a production smoke reads instead of a health endpoint. The build emits
 *   it (see `vite.config.ts`); the app and the smoke read it.
 */

export interface BuildInfo {
	/**
	 * The deployment's name: `mailwoman-earth`, `mailwoman-moon`, `mailwoman-mars`.
	 */
	app: string
	/**
	 * The short git revision the build was made from.
	 */
	revision: string
	/**
	 * ISO-8601 seconds, `Z` suffix.
	 */
	buildTime: string
}

export function renderBuildInfo(info: BuildInfo): string {
	return `${JSON.stringify(info, null, "\t")}\n`
}
```

- [ ] **Step 4: Run the tests and the checks**

```bash
yarn vitest --run --config vitest.fast.config.ts packages/earth/test/unit packages/site-kit/test/unit
yarn oxlint packages/earth packages/site-kit
yarn compile
yarn mwops health manifest-targets
```

Expected: 8 tests pass; oxlint reports nothing; `tsc -b` emits `packages/earth/out/{routes,config}.js` and `packages/site-kit/out/build-info.js`; `manifest-targets` reports nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/earth packages/site-kit
git commit -m "feat(earth,site-kit): routes and origins in the app, build-info in site-kit, all pure and tested"
```

---

### Task 4: Vite, the PWA and `build.json`

**Files:**

- Create: `packages/earth/vite.config.ts`, `packages/earth/index.html`, `packages/earth/lib/service-worker.ts`, `packages/earth/public/icon.svg`, `packages/earth/public/icon-192.png`, `packages/earth/public/icon-512.png`
- Create (placeholder until Task 5 fills it): `packages/earth/lib/main.tsx`

**Interfaces:**

- Consumes: `renderBuildInfo` from Task 3; `gitHead` from `@mailwoman/core/git`; `repoRootPath` from `@mailwoman/core/paths`; `isoSeconds` from `@mailwoman/core/utils`.
- Produces: `dist/index.html`, `dist/build.json`, `dist/manifest.webmanifest`, `dist/sw.js`, the hashed assets.

- [ ] **Step 1: The two site-kit Vite modules**

`packages/site-kit/lib/vite/build-info.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Emit `build.json` beside a Vite bundle: the static deployment record a production smoke fetches instead of a
 *   health endpoint. The revision is the repository's HEAD at build; Workers Builds checks out the commit it deploys.
 */

import { gitHead } from "@mailwoman/core/git"
import { repoRootPath } from "@mailwoman/core/paths"
import { isoSeconds } from "@mailwoman/core/utils"
import type { Plugin } from "vite"

import { renderBuildInfo } from "#build-info"

export function buildInfoPlugin(options: { app: string }): Plugin {
	return {
		name: "mailwoman-build-info",
		async generateBundle() {
			const revision = await gitHead(repoRootPath(), { short: true })

			this.emitFile({
				type: "asset",
				fileName: "build.json",
				source: renderBuildInfo({ app: options.app, revision, buildTime: isoSeconds() }),
			})
		},
	}
}
```

`isoSeconds` is defined in `packages/core/lib/utils/time.ts` and reaches consumers through the `@mailwoman/core/utils` barrel; there is no `./utils/time` subpath.

`packages/site-kit/lib/vite/pwa.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The installable-PWA options every mailwoman site shares: `injectManifest` over `lib/service-worker.ts`, a precache
 *   of the shell and its hashed assets only, and a manifest whose identity is the origin. A model, a gazetteer
 *   database or a tile is never precached; those stay range-fetched on demand.
 */

import type { VitePWAOptions } from "vite-plugin-pwa"

export interface PWAIdentity {
	/**
	 * The origin with a trailing slash, e.g. `https://earth.mailwoman.ai/`. It is the manifest `id`, which is what
	 * keeps the three sites' installations distinct.
	 */
	origin: string
	name: string
	shortName: string
	themeColor: string
}

export function installablePWA(identity: PWAIdentity): Partial<VitePWAOptions> {
	return {
		strategies: "injectManifest",
		srcDir: "lib",
		filename: "service-worker.ts",
		registerType: "prompt",
		injectManifest: {
			globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
		},
		manifest: {
			id: identity.origin,
			name: identity.name,
			short_name: identity.shortName,
			start_url: "/",
			scope: "/",
			display: "standalone",
			background_color: identity.themeColor,
			theme_color: identity.themeColor,
			icons: [
				{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
				{ src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
			],
		},
	}
}
```

- [ ] **Step 1b: Write the Vite config**

`packages/earth/vite.config.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Earth build: React, the PWA manifest and service worker, and `build.json`. There is no server side; every
 *   output is a static asset Cloudflare serves without invoking a Worker.
 */

import { buildInfoPlugin } from "@mailwoman/site-kit/vite/build-info"
import { installablePWA } from "@mailwoman/site-kit/vite/pwa"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

export default defineConfig({
	plugins: [
		react(),
		VitePWA(
			installablePWA({
				origin: "https://earth.mailwoman.ai/",
				name: "Mailwoman Earth",
				shortName: "Earth",
				themeColor: "#0b1020",
			})
		),
		buildInfoPlugin({ app: "mailwoman-earth" }),
	],
	build: {
		outDir: "dist",
		sourcemap: true,
	},
	server: { port: 7781, strictPort: true },
})
```

- [ ] **Step 2: The service worker, the HTML, the icons**

`packages/earth/lib/service-worker.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Earth service worker. This file is the source `vite-plugin-pwa` injects the precache manifest into: the app
 *   shell, its hashed assets, the icons and the manifest. The range cache for the gazetteer databases joins this file
 *   when the runtime moves in; nothing here caches a model, a database or a tile.
 */

/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching"

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
```

`packages/earth/index.html`:

```html
<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>Mailwoman Earth</title>
		<link rel="icon" href="/icon.svg" type="image/svg+xml" />
		<link rel="preconnect" href="https://public.mailwoman.ai" crossorigin />
		<link rel="preconnect" href="https://tiles.mailwoman.ai" crossorigin />
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="/lib/main.tsx"></script>
	</body>
</html>
```

`packages/earth/public/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Mailwoman Earth">
	<rect width="512" height="512" rx="96" fill="#0b1020" />
	<circle cx="256" cy="256" r="150" fill="none" stroke="#7fd1ff" stroke-width="28" />
	<path d="M106 256h300M256 106c-60 60-60 240 0 300M256 106c60 60 60 240 0 300" fill="none" stroke="#7fd1ff" stroke-width="20" stroke-linecap="round" />
</svg>
```

Render the two PNGs once with ImageMagick, which the lab has at `/usr/bin/convert`:

```bash
cd packages/earth/public && convert -background none icon.svg -resize 192x192 icon-192.png && convert -background none icon.svg -resize 512x512 icon-512.png && cd -
```

`packages/earth/lib/main.tsx` (Task 5 replaces the body):

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<p>Mailwoman Earth</p>)
```

- [ ] **Step 3: Build and read the output**

```bash
yarn workspace @mailwoman/earth build > /tmp/earth-build.log 2>&1; echo "EXIT=$?" >> /tmp/earth-build.log; tail -12 /tmp/earth-build.log
ls packages/earth/dist
cat packages/earth/dist/build.json
node -e "const m=require('./packages/earth/dist/manifest.webmanifest');console.log(m.id,m.start_url,m.display,m.icons.length)"
```

Expected: `EXIT=0`; `dist/` holds `index.html`, `build.json`, `manifest.webmanifest`, `sw.js`, `icon-192.png`, `icon-512.png`, `icon.svg`, `assets/`; `build.json` carries `app`, a 7-plus-character `revision`, and a `buildTime` ending in `Z`; the manifest prints `https://earth.mailwoman.ai/ / standalone 2`.

- [ ] **Step 4: Typecheck the config and worker**

```bash
yarn tsc -p packages/earth/tsconfig.test.json --noEmit
```

Expected: no error. `vite/client` and `vite-plugin-pwa/client` in `types` supply `virtual:pwa-register` and `import.meta.env`.

- [ ] **Step 5: Commit**

```bash
git add packages/earth packages/site-kit
git commit -m "feat(earth,site-kit): Vite build with the PWA manifest, a precache service worker, and build.json"
```

---

### Task 5: The app mounts the geocoder on the fake runtime

**Files:**

- Create: `packages/earth/lib/App.tsx`, `packages/earth/lib/styles/app.css`
- Modify: `packages/earth/lib/main.tsx`

**Interfaces:**

- Consumes: `GeocoderDemo`, `DemoPanels` from `@mailwoman/react/map`; `makeDemoRuntime` from `@mailwoman/react/map/fake-runtime` (Task 1); `routeForPath`, `queryFromSearch`, `Route` from `#routes` (Task 3).
- Produces: the DOM the smoke in Task 7 drives: the input `#mw-pipeline-input` and the submit button `GeocoderDemo` already renders, a `<main data-route="…">` wrapper, a `[data-testid="not-found"]` view.

The component names (`GeocoderDemo`, `DemoPanels`, `DemoRuntime`) are renamed in the second Earth plan, at the moment the real runtime lands; this plan uses them as exported today.

- [ ] **Step 1: Write the app**

`packages/earth/lib/styles/app.css`:

```css
html,
body,
#root {
	height: 100%;
	margin: 0;
}

body {
	background: #0b1020;
	color: #e6edf3;
	font-family: system-ui, sans-serif;
}

main[data-route] {
	position: relative;
	height: 100%;
}

.not-found {
	display: grid;
	place-content: center;
	height: 100%;
	text-align: center;
}
```

`packages/earth/lib/App.tsx`:

```tsx
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   Route → view. The geocoder and the debug view mount the same page; the debug view opens the drawer by default.
 *   This shell mounts the FAKE runtime: canned parse and resolve, an offline map style. The real runtime replaces
 *   `makeDemoRuntime()` when it moves in from the docs site, and nothing else here changes.
 */

import "maplibre-gl/dist/maplibre-gl.css"
import "@mailwoman/react/styles.css"
import "./styles/app.css"

import { GeocoderDemo } from "@mailwoman/react/map"
import { makeDemoRuntime } from "@mailwoman/react/map/fake-runtime"
import { useMemo } from "react"

import { queryFromSearch, Route, routeForPath } from "#routes"

const PRESETS = [
	{ label: "White House", value: "1600 Pennsylvania Ave NW, Washington, DC 20500" },
	{ label: "Empire State", value: "350 5th Ave, New York, NY 10118" },
	{ label: "ZIP only", value: "90210" },
]

const DEFAULT_ADDRESS = "1600 Pennsylvania Ave NW, Washington, DC 20500"

function NotFound({ pathname }: { pathname: string }) {
	return (
		<section className="not-found" data-testid="not-found">
			<h1>Not here</h1>
			<p>
				<code>{pathname}</code> is not a page of Mailwoman Earth. <a href="/">Go to the geocoder.</a>
			</p>
		</section>
	)
}

export function App() {
	const route = routeForPath(location.pathname)
	const query = queryFromSearch(location.search)
	const runtime = useMemo(() => makeDemoRuntime(), [])

	if (route === null) return <NotFound pathname={location.pathname} />

	return (
		<main data-route={route}>
			<GeocoderDemo runtime={runtime} defaultAddress={query ?? DEFAULT_ADDRESS} presets={PRESETS} />
		</main>
	)
}
```

`packages/earth/lib/main.tsx` body:

```tsx
import { createRoot } from "react-dom/client"
import { registerSW } from "virtual:pwa-register"

import { App } from "./App.tsx"

registerSW()

const root = document.getElementById("root")

if (!root) throw new Error("index.html has no #root")

createRoot(root).render(<App />)
```

The debug and trace routes render the same geocoder in this plan; the drawer-open default and the trace page arrive with the runtime plan, which is where `DemoPanels` and the debug drawer move from `docs/src/pages/demo/`.

- [ ] **Step 2: Build and look**

```bash
yarn workspace @mailwoman/earth build > /tmp/earth-build.log 2>&1; echo "EXIT=$?" >> /tmp/earth-build.log; tail -3 /tmp/earth-build.log
```

Expected: `EXIT=0`. Then `yarn workspace @mailwoman/earth preview` and open `http://localhost:7780/?q=90210` in a browser: the geocoder renders over a plain background map, the input reads `90210`, submitting shows the canned New York result with a marker.

- [ ] **Step 3: Commit**

```bash
git add packages/earth
git commit -m "feat(earth): the app mounts the geocoder on the fake runtime, with routes and a not-found view"
```

---

### Task 6: `wrangler.toml`, the CORS origins, and the dry run

**Files:**

- Create: `packages/earth/wrangler.toml`
- Modify: `packages/tile-worker/lib/cors.ts` (`AllowedOrigins`)

- [ ] **Step 1: The wrangler configuration**

`packages/earth/wrangler.toml`:

```toml
# Earth: static assets only. No `main`, so a navigation or an asset request never invokes a Worker; the SPA fallback
# serves index.html for every path and the app reads location.pathname. The Workers Builds project that deploys this
# file is configured in the Cloudflare dashboard (README, "Deployment").

name = "mailwoman-earth"
compatibility_date = "2026-09-07"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

- [ ] **Step 2: The three origins**

In `packages/tile-worker/lib/cors.ts`, add to `AllowedOrigins` after `"https://mailwoman.ai"`:

```ts
	"https://earth.mailwoman.ai",
	"https://moon.mailwoman.ai",
	"https://mars.mailwoman.ai",
```

- [ ] **Step 3: Dry run**

```bash
yarn workspace @mailwoman/earth build
yarn workspace @mailwoman/earth deploy:dry-run 2>&1 | tail -8
```

Expected: wrangler reports the asset upload plan for `dist/` and ends with `--dry-run: exiting now.` with no error. A `wrangler` prompt for login means the dry run tried to authenticate; `WRANGLER_SEND_METRICS=false` and `CLOUDFLARE_API_TOKEN=` unset are the expected state for a dry run and it must not need a token.

- [ ] **Step 4: The tile worker's tests**

```bash
yarn vitest --run packages/tile-worker
```

Expected: the same pass count as on `main`.

- [ ] **Step 5: Commit**

```bash
git add packages/earth/wrangler.toml packages/tile-worker/lib/cors.ts
git commit -m "feat(earth): assets-only wrangler configuration; the tile worker admits the three body origins"
```

---

### Task 7: The browser smoke and its CI step

**Files:**

- Create: `packages/earth/playwright.config.ts`, `packages/earth/test/browser/shell.spec.ts`
- Modify: `.github/workflows/test.yml` (the `react` leg gains one step)

- [ ] **Step 1: The Playwright configuration**

`packages/site-kit/lib/playwright.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The Playwright configuration a static site's smoke runs under: `vite preview` over a fresh build, which serves
 *   `dist/` with the same SPA fallback Cloudflare applies, or a deployment when the named variable carries its URL.
 */

import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test"

export interface PreviewConfigOptions {
	port: number
	/**
	 * The environment variable that, when set, points the specs at a deployment instead of the preview server.
	 */
	remoteURLVariable: string
}

export function previewConfig(options: PreviewConfigOptions): PlaywrightTestConfig {
	// oxlint-disable-next-line sister-software/no-process-globals -- Playwright loads this outside the module graph, as docs/playwright.config.ts explains
	const env = process.env
	const remoteURL = env[options.remoteURLVariable]
	const baseURL = remoteURL ?? `http://localhost:${options.port}`
	const CI = Boolean(env["CI"])

	return defineConfig({
		testDir: "./test/browser",
		timeout: 60_000,
		retries: CI ? 1 : 0,
		use: { baseURL, ...devices["Desktop Chrome"] },
		projects: [{ name: "chromium" }],
		webServer: remoteURL
			? undefined
			: { command: "yarn build && yarn preview", url: baseURL, timeout: 300_000, reuseExistingServer: !CI },
	})
}
```

`packages/earth/playwright.config.ts`:

```ts
import { previewConfig } from "@mailwoman/site-kit/playwright"

export default previewConfig({ port: 7780, remoteURLVariable: "MAILWOMAN_EARTH_URL" })
```

The one `process.env` read carries the same scoped disable `docs/playwright.config.ts` carries, for the same reason: Playwright loads this file with its own loader, outside the typed `$public` view.

- [ ] **Step 2: The smoke**

`packages/earth/test/browser/shell.spec.ts`:

```ts
/**
 * @copyright Sister Software
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 *
 *   The shell smoke: every route serves the app, `?q=` pre-fills the query, the fake runtime completes a query, and the
 *   static deployment records exist. No model, no gazetteer, no tile is fetched.
 */

import { expect, test } from "@playwright/test"

test.describe("Mailwoman Earth shell", () => {
	test("/ renders the geocoder and the fake runtime completes a query", async ({ page }) => {
		await page.goto("/?q=90210")

		await expect(page.locator("main[data-route='geocoder']")).toBeVisible()
		await expect(page.locator("#mw-pipeline-input")).toHaveValue("90210")

		await page.locator("button[type='submit']").click()

		await expect(page.getByText("New York").first()).toBeVisible()
	})

	test("/debug and /trace serve the app", async ({ page }) => {
		await page.goto("/debug")
		await expect(page.locator("main[data-route='debug']")).toBeVisible()

		await page.goto("/trace")
		await expect(page.locator("main[data-route='trace']")).toBeVisible()
	})

	test("an unknown path is the not-found view, served by the SPA fallback", async ({ page }) => {
		const response = await page.goto("/demo")

		expect(response?.status()).toBe(200)
		await expect(page.getByTestId("not-found")).toBeVisible()
	})

	test("build.json and the manifest are static assets", async ({ request }) => {
		const build = await request.get("/build.json")
		expect(build.status()).toBe(200)
		const info = (await build.json()) as { app: string; revision: string; buildTime: string }
		expect(info.app).toBe("mailwoman-earth")
		expect(info.revision.length).toBeGreaterThanOrEqual(7)
		expect(info.buildTime.endsWith("Z")).toBe(true)

		const manifest = await request.get("/manifest.webmanifest")
		expect(manifest.status()).toBe(200)
		expect(((await manifest.json()) as { id: string }).id).toBe("https://earth.mailwoman.ai/")

		const worker = await request.get("/sw.js")
		expect(worker.status()).toBe(200)
	})
})
```

- [ ] **Step 3: Run it**

```bash
yarn workspace @mailwoman/earth exec playwright install chromium
yarn workspace @mailwoman/earth test:browser 2>&1 | tail -12
```

Expected: 4 passed. If `#mw-pipeline-input` is not the input's id, `grep -rn "mw-pipeline-input" packages/react/lib` names the current one.

- [ ] **Step 4: The CI step**

In `.github/workflows/test.yml`, in the `react` leg, after the step that runs `yarn workspace @mailwoman/react test:browser`, add:

```yaml
- name: Earth shell smoke
  run: yarn workspace @mailwoman/earth test:browser
```

That leg installs Chromium with `yarn workspace @mailwoman/react exec playwright install --with-deps chromium`; the browser cache is per runner, so the earth step finds it as long as both workspaces resolve the same `@playwright/test` (they do: `^1.63.0`). Run `yarn mwops health no-root-scripts` after the edit, because that check reads every workflow's `run:` lines.

- [ ] **Step 5: Commit**

```bash
git add packages/earth packages/site-kit .github/workflows/test.yml
git commit -m "test(earth,site-kit): the shell smoke under Playwright, on the preview server and in the react CI leg"
```

---

### Task 8: Preflight and the PR

- [ ] **Step 1: The full preflight**

```bash
yarn compile
yarn health > /tmp/health.log 2>&1; echo "EXIT=$?" >> /tmp/health.log; grep -n "✗\|error:\|EXIT=" /tmp/health.log | head
yarn typecheck:tests
yarn ci:test:fast > /tmp/fast.log 2>&1; echo "EXIT=$?" >> /tmp/fast.log; grep -E "Tests |Test Files|EXIT=" /tmp/fast.log
yarn workspace @mailwoman/react test:browser
yarn workspace @mailwoman/earth test:browser
```

Expected: `health` passes every step (if `health:debt` fails on counters this branch did not move, compare with `main` before touching the baseline); `typecheck:tests` passes; the fast leg passes with the two new unit files counted; both browser suites pass.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/earth-shell
gh pr create --title "Earth shell: packages/earth, the geocoder on a fake runtime, static Workers Assets" --body-file - <<'EOF'
Implements the shell half of docs/superpowers/specs/2026-09-06-earth-app-design.md by docs/superpowers/plans/2026-09-07-earth-shell.md.

- `@mailwoman/react/map/fake-runtime`: the stories' and tests' fake geocoder runtime is a public subpath; the app mounts it
- `packages/site-kit` (private): the build.json plugin, the installable-PWA options and the Playwright preview config, written once for this app and the planetary app
- `packages/earth` (`@mailwoman/earth`, private): Vite + React, `vite-plugin-pwa` (injectManifest, precache-only worker), `build.json`, routes `/`, `/debug`, `/trace` with `?q=`, a not-found view
- `wrangler.toml` with `assets` only; the tile worker admits `earth`, `moon`, `mars` origins
- Playwright smoke on `vite preview`, added to the react CI leg
- Registered in `workspaces`, both `tsconfig.json` references, `SANCTIONED_RELEASE_ABSENCES`, the dependency-cruiser browser list

Not in this PR: the runtime (still in docs), the renames, the docs redirects. Those are the second Earth plan.

The Workers Builds project (root directory `packages/earth`, build `yarn build`, deploy `npx wrangler deploy`, branch `main`) is a dashboard step for the operator; the README carries the table.

https://claude.ai/code/session_01ADYjzV88cHb94MRW4Dn1Aq
EOF
```

- [ ] **Step 3: Record the one operator step**

The Cloudflare dashboard project cannot be created from the repository. State it in the PR and in the handoff: create the Workers Builds project for `mailwoman-earth` with the README's settings and the custom domain `earth.mailwoman.ai`. The first build proves the yarn-root assumption; the README carries the fallback.
