# @mailwoman/react

This package provides React components and headless hooks for [mailwoman](https://mailwoman.ai). It
packages the parse/geocode/POI explorers from the docs site as smaller parts for use in any React app.

## What's in the box

The package contains two composed explorers, plus the small presentational units and headless hooks
they are built from:

- **`POIExplorer`** is a self-contained POI-intent tester (classify → subject → OverpassQL). The intent
  path runs entirely offline over `@mailwoman/kind-classifier`, `@mailwoman/poi-taxonomy`, and
  `@mailwoman/query-shape`, without weights or network access. A live poi.db search is opt-in through an
  injected `runLiveSearch` probe, so the httpvfs/worker implementation never enters this package's graph.
- **`PipelineExplorer`** is a parse and resolve tester driven by an **injected `PipelineRuntime`**. The
  host supplies `runParse` (compute shape → classify → resolve) and the heavy visualizers as `panels`,
  which keeps onnxruntime-web, sql.js-httpvfs, and node builtins out of this package entirely.

The headless hooks, `usePOISearch` and `useParsePipeline`, own the state machines. The presentational
units (`QueryInput`, `SubjectPanel`, `OverpassBlock`, `LiveResultsBlock`, `ComponentTable`,
`ResolvedPlace`, `CandidatePicker`, `KindBadge`, `LoadingIndicator`, …) are pure and prop-driven.

## Usage

```tsx
import { POIExplorer, PipelineExplorer } from "@mailwoman/react"
import "@mailwoman/react/styles.css"
```

Styling ships as a standalone stylesheet (`@mailwoman/react/styles.css`). It is plain CSS with a `mw-`
prefix and reads Infima tokens, so it renders correctly both inside Docusaurus and standalone. No
component imports CSS, so the bare package import stays safe to load in Node.

## Development

- `yarn workspace @mailwoman/react storybook` runs Storybook (Vite) for every unit and the composed
  explorers, with mocked runtimes that need no network or database.
- `yarn workspace @mailwoman/react test:browser` runs the Vitest browser-mode component and hook tests
  (Playwright / headless Chromium).

## License

AGPL-3.0-only OR LicenseRef-Commercial. See the [mailwoman repository](https://github.com/sister-software/mailwoman).
