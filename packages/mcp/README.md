# @mailwoman/mcp

An **MCP server** exposes [Mailwoman](https://mailwoman.post)'s parse, geocode and POI tools to agents over stdio. It has no HTTP endpoint. An MCP client launches it as a subprocess.

## Tools

| Tool                             | What it does                                                                 | Needs the model + a gazetteer |
| -------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| `mailwoman_parse`                | Runtime-pipeline parse (optionally POI-aware)                                | Yes                           |
| `mailwoman_geocode`              | Street-level geocode cascade                                                 | Yes                           |
| `mailwoman_poi_search`           | POI-intent extraction, executed against a wired `poi.db`                     | Yes                           |
| `mailwoman_overpass_export`      | Renders a POI query as OverpassQL (prints the query, never runs it)          | Yes                           |
| `mailwoman_layer_manifest`       | Reads a spatial-layer database's provenance manifest + coverage summary      | No                            |
| `mailwoman_bdc_filing_landscape` | Reads a `bdc.db` layer's filing census over census blocks or H3 cells        | No                            |
| `mailwoman_plausibility_check`   | Scores one claimed broadband-service assertion against filing + POI evidence | Only when it geocodes         |
| `mailwoman_filer_lookup`         | Reads the FCC filer identity crosswalk from a `filer.db` layer               | No                            |
| `mailwoman_filer_family`         | Reads a corporate family's membership from a `filer.db` layer                | No                            |

The server loads the `en-US` weights and opens a resolver when a model-backed tool first needs them. It doesn't
load these resources at startup. If neither `$MAILWOMAN_CANDIDATE_DB` nor a WOF distribution exists on the data root,
that first call returns the `mailwoman data pull candidate` fix instead of an internal resolver error.

## Config

```json
{
	"mcpServers": {
		"mailwoman": {
			"command": "mailwoman-mcp",
			"args": ["--poi-db", "/path/to/poi.db"]
		}
	}
}
```

`--poi-db <path>` wires `mailwoman_poi_search` (and `mailwoman_parse`'s `poi: true` path) to a real database. Without the flag, those tools return intent only.
