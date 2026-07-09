---
name: run-docs
description: Run, build, smoke-test, and screenshot the @mailwoman/docs Docusaurus site (the marketing + docs + /demo app published to mailwoman.sister.software). Use this skill when asked to "run the docs," "start docusaurus," "screenshot a docs page," "verify a doc change," "test the /demo page," or to validate any change inside docs/.
---

Paths below are relative to `docs/` (the workspace root). The skill directory is `docs/.claude/skills/run-docs/`.

The site is **Docusaurus 3.10** + React 19, served on `http://localhost:7770`. The agent-facing driver is `.claude/skills/run-docs/driver.mts` — a Playwright wrapper around an already-running dev server. `yarn start` is human-only; the driver is what you use to actually look at pages, surface console errors, and take screenshots.

## Prerequisites

Yarn 4 workspaces. Run install from `docs/` (it installs the whole workspace):

```bash
yarn install
```

Playwright's headless Chromium needs to be present once per machine:

```bash
npx playwright install chromium
```

(Hosted by Playwright 1.60 at `/Users/<you>/Library/Caches/ms-playwright/`. The `playwright` package itself lives at the repo root's `node_modules/` — it's a devDep on the universe package, hoisted up; `@playwright/test` resolves from `docs/` even though it's not in `docs/package.json`.)

## Build

You don't need to build for dev. Two optional pre-steps:

- **`/demo` static assets.** The page renders without them but live address resolution won't work. To enable, the weights workspace must have its binaries linked first:

  ```bash
  node ../neural-weights-en-us/scripts/link-dev-weights.ts
  node docs/scripts/build-demo-assets.ts
  ```

  Skip both if you only care about prose pages or the demo's static UI.

- **Production build.** Static output to `build/`:
  ```bash
  yarn build
  ```

## Run (agent path)

The driver assumes the dev server is already up. Start it once, in the background, then drive it as many times as you want:

```bash
yarn start > /tmp/docs-start.log 2>&1 &
# wait until ready (first build is ~10–20s, but on a clean .docusaurus cache can be 60s+)
until curl -fsS http://localhost:7770 -o /dev/null; do sleep 2; done
```

Then use the driver (from the docs root) to check pages, take screenshots, and run JS snippets in the page context:

```bash
# screenshot a page (full-page, 1280×800 viewport)
node .claude/skills/run-docs/driver.mts --screenshot / /tmp/docs-home.png
node .claude/skills/run-docs/driver.mts --screenshot /demo/ /tmp/docs-demo.png

# HTTP + console-error + soft-404 check for one route
node .claude/skills/run-docs/driver.mts --check /docs/understanding/

# smoke the five key routes (/, /demo/, /research/, /docs/understanding/, /docs/plan/) —
# exits 1 on any soft-404, HTTP >=400, or console error
node .claude/skills/run-docs/driver.mts --smoke

# run JS in the page context and print the JSON return value
node .claude/skills/run-docs/driver.mts --eval / "return document.querySelector('h1')?.innerText"
```

Override the base URL with `MAILWOMAN_DOCS_URL=https://mailwoman.sister.software node .../driver.mts --check /docs/` to point the same driver at the deployed site.

Screenshots default to `/tmp/mailwoman-docs/<route>.png` if you omit the output path. Always `Read` the file after taking it — a 200 OK with a blank screenshot is the most common silent failure mode here (e.g. a JS bundle that errored after hydration).

## Run (human path)

```bash
yarn start         # foreground; serves http://localhost:7770, watch mode
yarn serve         # serves a prior `yarn build` output
```

Both are useless headless except as a server for the driver above. `yarn start` does not auto-open a browser (`--no-open` is set in `package.json`).

## Test

```bash
yarn typecheck                              # tsc, no emit
yarn test:e2e                               # playwright against PROD by default
MAILWOMAN_DEMO_URL=http://localhost:7770 yarn test:e2e   # against local dev
```

The Playwright e2e suite (`test/browser/*.spec.ts`) targets the live `/demo` page and assumes the WOF+ONNX assets are in place. It's slow (cold-load budget is 180s; see `playwright.config.ts:42`). For "did my doc change render?" the driver above is the right tool — Playwright e2e is reserved for the `/demo`-app behavior.

## Gotchas

- **Docusaurus serves its 404 page with HTTP 200.** A `curl -o /dev/null -w '%{http_code}' http://localhost:7770/some/typo` returns `200` even though the page renders "Page Not Found." The driver's `check`/`smoke` commands sniff the rendered `<h1>` and flag this as `SOFT-404` — trust that, not the status code. If you're writing your own check, do the same.
- **The bare `/docs/` URL is a soft-404.** The actual docs entry is `/docs/understanding/`. The nav link labelled "Docs" points there. The smoke list reflects this; don't add `/docs/` thinking it'll be a sanity check.
- **`/research/` has a known React console error.** A research blog post (probably MDX) is rendering a `RegExp` as a child: `Objects are not valid as a React child (found: [object RegExp])`. `smoke` will exit 1 because of it. This is a real existing bug, not driver flakiness — if you're not the one fixing it, ignore the `/research/` failure and check the other three routes individually.
- **`@docusaurus/theme-mermaid` is listed but not always installed.** If `yarn start` errors with "Docusaurus was unable to resolve the `@docusaurus/theme-mermaid` theme," run `yarn install` from `docs/`. The lockfile knows about it; whatever cleared `node_modules/` (a `yarn clean`, a workspace migration) left it stale.
- **The dev server uses port 7770, not the Docusaurus default 3000.** Hardcoded in `package.json` scripts. Don't `curl :3000`.
- **`networkidle` is required, not `domcontentloaded`.** Docusaurus is SPA-ish; `domcontentloaded` fires before the React hydration assets land and your screenshot will show "Loading..." The driver already uses `networkidle`; if you write your own Playwright snippet, do the same.
- **`/demo/` renders without the `static/mailwoman/*.onnx,*.model,*.db` artifacts** but address resolution won't work — clicking "Parse + resolve" silently no-ops or errors in the console. The page screenshot looks correct; the feature is broken. If you're testing the demo _behavior_, run `node docs/scripts/build-demo-assets.ts` first (which needs `$MAILWOMAN_DATA_ROOT/wof/...` or `PLAYPEN_WOF_*_DB` env overrides).
- **The driver does not launch or kill the dev server.** This is deliberate — Docusaurus's first build is slow and you'll typically run the driver 5–20 times against one server. Tear down explicitly with `pkill -f 'docusaurus start'` when done.

## Troubleshooting

| Symptom                                                                                 | Fix                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `browserType.launch: Executable doesn't exist at .../chrome-headless-shell`             | `npx playwright install chromium`                                                                                                                                        |
| `[ERROR] Error: Docusaurus was unable to resolve the "@docusaurus/theme-mermaid" theme` | `yarn install` (lockfile has it; node_modules is out of date)                                                                                                            |
| Driver screenshot shows a blank/loading page                                            | The page errored after hydration. Use `driver.mts --check <path>` to see console errors; or `eval <path> "return document.body.innerText.slice(0,200)"` to inspect text. |
| `yarn start` hangs at "Starting the development server..." for >2 min                   | First-time builds with a cold `.docusaurus` cache can take that long; subsequent starts are seconds. If it sits beyond 3 min, kill it, `rm -rf .docusaurus`, retry.      |
| `EADDRINUSE :7770`                                                                      | A previous `yarn start` is still alive. `pkill -f 'docusaurus start'`.                                                                                                   |
