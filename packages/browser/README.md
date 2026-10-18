# Browser automation

`@mailwoman/browser` provides TypeScript browser sessions for data acquisition, rendering,
and agent interaction. Stealth is enabled for every session. Our own E2E suites use standard
Playwright directly.

The workspace is private and runs from the repository checkout. Install the browser once:

```sh
yarn install
yarn playwright install chromium
```

## Programmatic use

`createBrowserSession` returns the ordinary Playwright browser and context. The caller owns
the session with `await using`. Pages, frames, locators, network events, downloads, and
context storage state remain Playwright APIs.

```ts
import { createBrowserSession } from "@mailwoman/browser"

await using session = await createBrowserSession({
	contextOptions: { locale: "en-GB" },
})
const page = await session.context.newPage()
await page.goto(sourceURL, { waitUntil: "domcontentloaded" })
await page.getByRole("link", { name: "Download" }).waitFor()

const [download] = await Promise.all([
	page.waitForEvent("download"),
	page.getByRole("link", { name: "Download" }).click(),
])
await download.saveAs(destination)
```

`withBrowserPage(options, callback)` handles a single-page session and returns
`{ result, consoleErrors }`. It awaits the callback before closing the context and browser,
including when the callback rejects. `createBrowserSession` also accepts `launchOptions`
and a `cdpEndpoint` for connecting to an existing Chromium instance. A CDP connection creates
a separate context; it does not use the existing browser's logged-in tabs.

Use a browser to discover portal requests, inspect rendered metadata, establish sessions,
or perform interactions required for downloads. When an endpoint can be called directly,
use the existing HTTP client and streaming downloader. Record source URLs, retrieval dates,
licenses, and file hashes through the acquisition package's manifest writer.

Wait for the element or response the acquisition needs. A navigation event alone does not
establish that a page has finished rendering, and continuous background requests can prevent
`networkidle` from completing.

## Agent access through MCP

The repository's `.mcp.json` configures `mailwoman-browser` with this command:

```sh
node lib/browser-mcp/cli.ts
```

The command serves Microsoft's Playwright MCP tools over stdio. It starts the shared browser
on the first browser tool call. Navigation, snapshots, clicks, evaluation, console messages,
network inspection, and screenshots use the upstream tools. Screenshot responses retain
their MCP image content. `browser_close` releases the session; a later navigation opens a
new session with stealth enabled. The process also releases its browser when the MCP
transport closes or it receives SIGINT or SIGTERM.

The command accepts these options:

| Option                   | Behavior                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| `--headed`               | Display the browser window. The default is headless.                    |
| `--storage-state <path>` | Load Playwright cookies and local storage into each new context.        |
| `--output-dir <path>`    | Set the directory for automatically named MCP artifacts.                |
| `--cdp-endpoint <url>`   | Connect to an existing Chromium instance and create a separate context. |

Acquire storage state programmatically with `session.context.storageState({ path })`.
The MCP session and a programmatic session share configuration, but they have separate
cookies and tabs unless the caller explicitly transfers storage state.

## Dependencies

The implementation uses `playwright-extra` with `puppeteer-extra-plugin-stealth`.
Each session creates its own launcher and plugin instance. It does not mutate Playwright's
shared Chromium export or add plugins to the E2E runner.

The Python `playwright_stealth` project was inspected as a reference. Its browser evasions
are JavaScript, and its Python code coordinates initialization scripts, launch flags, and
headers. This workspace uses the existing Node implementation and requires no Python runtime.
The MCP wrapper is pinned to `0.0.83`. Root Yarn resolutions keep its `playwright` and
`playwright-core` dependencies at the repository's `1.63.0`, replacing the wrapper's alpha
dependency. Update these together and check both the programmatic API and MCP when changing either.
