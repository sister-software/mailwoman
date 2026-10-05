# `@mailwoman/opportunity-app`

The interactive surface of the building and shared-route opportunity map in
[#2289](https://github.com/sister-software/mailwoman/issues/2289). It draws the building, route and district
collections that `@mailwoman/opportunity-map` computes for the synthetic Example District, recalculates a selection
of buildings through `selectionEconomics` under eight scenario controls, and links the selection to its dossier parts
and to its cost and value report. The application is private and is not deployed: it has no `wrangler.toml`, no
deploy target and no service worker. Every position, route path and economic input it shows is synthetic.

## Commands

The Vite build reads the compiled output of the workspaces it imports, so run `yarn compile` once before the first
build and after a change to one of those workspaces.

| Command                                                  | Does                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| `yarn workspace @mailwoman/opportunity-app dev`          | Vite development server on port 7792                             |
| `yarn workspace @mailwoman/opportunity-app build`        | the static bundle in `dist/`                                     |
| `yarn workspace @mailwoman/opportunity-app preview`      | serves `dist/` on port 7772                                      |
| `yarn workspace @mailwoman/opportunity-app test:browser` | builds, starts the preview server, runs the two Playwright specs |
| `yarn vitest run packages/opportunity-app`               | the unit tests beside the modules in `lib/`                      |

To open the application locally, run `yarn compile`, then
`yarn workspace @mailwoman/opportunity-app build && yarn workspace @mailwoman/opportunity-app preview`, and open
`http://localhost:7772`.

`OPPORTUNITY_BASEMAP_URL` is the one build variable. With a TileJSON URL for the Mailwoman basemap, the map draws the
`@mailwoman/cartographer` base style over that tileset. Without it, the map draws a stub style with zero sources, and
every request of the page goes to its own server. The browser tests build without it.

## What the page shows

Every value comes from one call of `opportunityView` in `lib/view.ts`, which calls `buildingFeatures`,
`districtFeatures`, `routeFeatures` and `selectionEconomics` from `@mailwoman/opportunity-map`, `reportLines` from
`@mailwoman/dossier`, and `renderScenarioReport` from `@mailwoman/route-scenarios`. The application adds, averages and
estimates no figure of its own. When a model function refuses its input, the page shows the refusal's message in
place of what the function would have returned. A selection that includes an unresolved unit total therefore shows
the message of `UnresolvedUnitTotalError` in place of figures.

A selected building's dossier part is the text of exactly the `reportLines` records whose `building` is that
building, in the report's order. `buildingReportPart` in `lib/evidence.ts` joins them one record per line.

A scale control switches the map between the building and district collections. A building with a resolved position
is a marker in its state's shape, numbered as its row in the building list. A district's marker sits at the first
position of its `MultiPoint` and gives the sum of its resolved unit totals and the count of its buildings with an
unresolved total. A route segment is a line: solid when a source record verifies it, dashed when it is proposed
construction, and wider when two selected buildings share it.

## Controls

Each control sets one model input, and Recalculate applies them all. A changed input that carries an `InputBasis`
takes the basis `operator_assumption`, stated by the scenario controls. `Scenario` gives month zero, the horizon, the
discount rate and the cost adjustment no `InputBasis` field, so the inputs table states for each of them whether the
scenario or the controls set it.

| Item 4 word | Control                                   | Model input                                                                                 |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| investment  | Cost adjustment, percent of the rate card | `Scenario.costAdjustment` over every cost category, or `null` at zero                       |
| value       | Take rate, percent of occupied units      | `Scenario.operating.uptake.takeRateBasisPoints`                                             |
| value       | Monthly price from month 0                | the month-0 step of `Scenario.operating.prices`                                             |
| evidence    | Dossier date                              | `buildDossier(records, { asOf })` and `Scenario.asOf`                                       |
| evidence    | Unit stage                                | `unitStage` of `buildingFeatures` and `districtFeatures`, and each `BuildingPlan.unitStage` |
| dates       | Month zero                                | `Scenario.monthZero`                                                                        |
| assumptions | Discount rate, effective annual percent   | `Scenario.annualDiscountRateBasisPoints`                                                    |
| assumptions | Horizon in months                         | `Scenario.horizonMonths`                                                                    |

The rate card of the Example District's scenario is stated on 2026-09-01, so `prepareScenario` refuses a dossier
date before that day, and the page shows that refusal in place of figures.

## Words and shapes

Color never carries a fact alone. Each building state has its words and a shape: partial availability is a circle
with its left half filled, known unserved a circle crossed by a bar, zero premises a hollow square, unknown coverage a
dashed circle around a question mark, and unknown unit count a dashed diamond around a question mark. A selected
building has the word selected, a check mark and a heavier outline. Each segment states `verified existing segment` or
`proposed construction`, and `shared` when two selected buildings use it. Every economic figure carries the word
synthetic. The legend names every shape in words.

The building list is the keyboard path. Tab reaches each checkbox row, Space selects or clears the building, and the
clear-selection button follows the list. Each checkbox's accessible description gives the word selected, the state in
words and the unit denominator, and each row lists the source records behind its state by identifier. The district
table, the segment list, the figures and the inputs table repeat every fact the map shows, and the markers are hidden
from assistive technology. A live region announces the recalculated figures after each change.

## Tests

| Spec                                     | Asserts                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/browser/scenario-controls.spec.ts` | Each control, changed with Example Buildings A, B and C selected, shows the figures of `selectionEconomics` for the changed scenario or its refusal's message; the evidence controls also change each building's state and denominator and each district's sums. A selection links to its dossier parts and to its cost and value report. |
| `test/browser/keyboard.spec.ts`          | With the keyboard alone, a reader selects and clears buildings and reads each state, selection, source list and segment status from accessible names, descriptions and text.                                                                                                                                                              |

Both specs fail when the page sends a request to a host other than the preview server.

## Limits

- The dataset is the synthetic Example District. Portfolio totals stay in `@mailwoman/opportunity-map`.
- Route paths are synthetic. A sourced route needs a path from a cited record.
- Cartograms are out of scope.
