# Older changes
## 1.0.5 (2026-06-17)
* (@GermanBluefox) Added debug for ICMP ping and TCP probe in `ping_host` tool

## 1.0.2 (2026-06-13)
* (@GermanBluefox) Some repo checker errors were fixed

## 1.0.0 (2026-06-12)
* (@GermanBluefox) Allowed node 18

## 0.3.1 (2026-06-11)
* (@GermanBluefox) Added `search_adapter_repository` tool to search the whole adapter repository (not only installed adapters)
* (@GermanBluefox) Added `ping_host` tool (ICMP ping + optional TCP probe) for network diagnostics

## 0.2.5 (2026-06-11)
* (@GermanBluefox) Supported direct import of MCP server

## 0.2.0 (2026-06-11)
* (@GermanBluefox) Many changes: see the previous changelog entry

## 0.1.5 (2026-06-11)
* (@GermanBluefox) Added wildcard support to `get_states` (e.g. `hue.0.*.brightness`)
* (@GermanBluefox) Added `set_states` for writing multiple states in one call (scenes/group actions)
* (@GermanBluefox) Added `delete_object` and `create_state` tools (gated by *Allow object/file changes*)
* (@GermanBluefox) Added `create_scene` tool that creates scenes for the ioBroker `scenes` adapter
* (@GermanBluefox) Added file management tools: `list_files`, `file_exists`, `delete_file`, `rename_file`, `mkdir`
* (@GermanBluefox) Added `list_adapters` to list installed adapters with metadata
* (@GermanBluefox) Extended `search_objects` with `type` and `adapter` filters; the keyword now also matches object names
* (@GermanBluefox) Extended `history_query` with the aggregations `count`, `minmax`, `percentile`, `quantile` and `integral`

## 0.1.4 (2026-05-28)
* (@GermanBluefox) Initial development

## 0.0.1 (2025-01-03)
* Initial release with basic web server functionality
*Configurable port, bind address, authentication, and SSL
