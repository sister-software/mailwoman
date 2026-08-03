# Template: how-to (`role: guide`)

A `guide` gets a reader who already has a goal from where they are to where they want to be. No scenario
storytelling, no teaching detour. Register rules are in [`../writing-system.md`](../writing-system.md) under
Register by role.

## Frontmatter skeleton

Copy this to the top of the new page. `verified-with` is required for this role.

```yaml
---
title: Replace a Nominatim endpoint
description: Serve the Nominatim-compatible API over Mailwoman and repoint an existing client at it.
role: guide
audience: product-reader
prerequisites: Node.js ≥24.18.0, a candidate gazetteer database
verified-with: mailwoman v8.7.0
---
```

## Section order

1. `# Title` — the outcome, phrased as a task.
2. **Outcome.** One sentence: what is true when the reader finishes.
3. **Prerequisites.** A list. Include the constraints that would break a step below.
4. **Steps.** Numbered `##` sections, one action each.
5. **Verify.** The command that proves it worked, with its output.
6. **Limits.** What this does not cover, each with the next action.
7. **Related.** Links out.

## Opening move

State the outcome in one sentence before any prerequisite, so a reader on the wrong path leaves on the first
line rather than the fourth step.

## Exemplar paragraph

> `@mailwoman/nominatim` speaks the Nominatim HTTP contract over the Mailwoman engine, so an existing client
> keeps working after you change its host. Forward geocoding (`/search`) and reverse geocoding (`/reverse`)
> are implemented, along with `/status` and an emitted `/openapi.json`; `/lookup` is planned and returns
> nothing useful yet, so a client that resolves known place identifiers is not ready to move. There is no
> PostgreSQL and no `osm2pgsql` import: the server reads a candidate gazetteer database you pass on the
> command line.

<!-- illustrative -->

```bash
npx @mailwoman/nominatim serve --port 8080 --candidate-db "$MAILWOMAN_DATA_ROOT/wof/candidates.db"
```

<!-- illustrative -->

```python
from geopy.geocoders import Nominatim

geo = Nominatim(domain="localhost:8080", scheme="http")
geo.geocode("1600 Pennsylvania Ave NW, Washington DC", addressdetails=True)
```

## Checks before commit

- The outcome sentence names a state, not an activity.
- Every command was executed, and the verify step's output is pasted from a real run.
- Unsupported cases appear in Limits with a next action, not as a discovery mid-procedure.
- No marketing language survives anywhere on the page.
- The audit checklist in [`../writing-system.md`](../writing-system.md) has been run over the draft.
