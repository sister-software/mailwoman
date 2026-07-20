# @mailwoman/react

React components + headless hooks for [mailwoman](https://mailwoman.sister.software) — the
parse/geocode/POI explorers from the docs site, decomposed and packaged for use in any React app.

## What's in the box

Two composed explorers, plus the small presentational units and headless hooks they decompose into:

- **`POIExplorer`** — a self-contained POI-intent tester (classify → subject → OverpassQL). The intent
  path runs entirely offline over `@mailwoman/kind-classifier`, `@mailwoman/poi-taxonomy`, and
  `@mailwoman/query-shape` — no weights, no network. A live poi.db search is opt-in via an injected
  `runLiveSearch` probe, so the httpvfs/worker machinery never enters this package's graph.
- **`PipelineExplorer`** — a parse + resolve tester driven by an **injected `PipelineRuntime`**. The
  host supplies `runParse` (compute shape → classify → resolve) and the heavy visualizers as `panels`,
  keeping onnxruntime-web, sql.js-httpvfs, and node builtins out of this package entirely.

The headless hooks — `usePOISearch`, `useParsePipeline` — own the state machines; the presentational
units (`QueryInput`, `SubjectPanel`, `OverpassBlock`, `LiveResultsBlock`, `ComponentTable`,
`ResolvedPlace`, `CandidatePicker`, `KindBadge`, `LoadingIndicator`, …) are pure and prop-driven.

## Usage

```tsx
import { POIExplorer, PipelineExplorer } from "@mailwoman/react"
import "@mailwoman/react/styles.css"
```

Styling ships as a standalone stylesheet (`@mailwoman/react/styles.css`) — plain, `mw-`-prefixed, and
Infima-token-aware, so it looks right both inside Docusaurus and standalone. No component imports CSS,
so the bare package import stays node-safe.

## Development

- `yarn workspace @mailwoman/react storybook` — Storybook (Vite) for every unit + the composed
  explorers, with mocked runtimes (no network/db).
- `yarn workspace @mailwoman/react test:browser` — Vitest browser-mode component + hook tests
  (Playwright / headless Chromium).

## License

AGPL-3.0-only OR LicenseRef-Commercial — see the [mailwoman repository](https://github.com/sister-software/mailwoman).
