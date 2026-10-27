# Older changes
## 1.6.0 (2026-10-26)
* (@GermanBluefox) Added the `check_permissions` tool: what the user of the MCP session may do with an object
* (@GermanBluefox) `install_package` reports whether the restarted instances came up again and their first log lines
* (@GermanBluefox) `get_states` returns `exists: false` for an unknown ID; `get_logs` returns the time of the newest line and the size of the log file
* (@GermanBluefox) A confirmation dismissed by the client explains how to turn off the confirmations instead of "Cancelled by the user"
* (@GermanBluefox) A wrong password is logged with the address and the User-Agent of the client
* (@GermanBluefox) Updated `@iobroker/mcp-server` to 1.7.0 and `@iobroker/webserver` to 3.3.2

## 1.5.1 (2026-10-24)
* (@GermanBluefox) The Default User is selected from a list of the ioBroker users

## 1.5.0 (2026-10-24)
* (@GermanBluefox) With authentication, the tools run with the permissions of the logged-in user instead of the Default User; the Default User is now only shown when authentication is off
* (@GermanBluefox) As a web extension, the default user of the `web` instance is used
* (@GermanBluefox) An upload link can only be used by the user that created it

## 1.4.0 (2026-10-24)
* (@GermanBluefox) Tool results are kept below the 1 MiB limit of MCP clients: lists are paged, other results are replaced by a download link (#63)
* (@GermanBluefox) Added the option "Allow download/upload links" (on by default): large files and results can be fetched and uploaded with curl, e.g. a `.tgz` for "install_package"

## 1.3.0 (2026-10-23)
* (@GermanBluefox) Added the option "Allow installing packages" (off by default, only for developers): MCP clients can install an adapter package from npm, GitHub, a URL or a `.tgz` file
* (@GermanBluefox) Added options to control instances, manage adapters, change scripts and send messages to adapters (all off by default) and to ask for a confirmation before dangerous actions
* (@GermanBluefox) Fixed: as a web extension the outdated built-in MCP server was loaded instead of `@iobroker/mcp-server`

## 1.2.1 (2026-10-19)
* (@Garfonso) Fixed: with "Allow object changes" enabled, MCP clients received no tools at all in some installations (ioBroker/ioBroker.mcp#70)
* (@GermanBluefox) `set_states` checks the write permission of all states first and writes nothing if one of them may not be written by the Default User (ioBroker/ioBroker.mcp#71)
* (@GermanBluefox) Completed the translations of the OAuth settings (ioBroker/ioBroker.mcp#73)

## 1.1.7 (2026-09-15)
* (@GermanBluefox) Added instructions for connecting ChatGPT and Claude (via ioBroker Remote or directly)
* (@GermanBluefox) Added IP address selector
* (@GermanBluefox) New option "Mark setting states as destructive" (default on): `set_state`/`set_states` can be declared as non-destructive writes

## 1.1.4 (2026-09-03)
* (@GermanBluefox) `read_file` reads large files in chunks: new optional `offset`/`length` parameters, at most 512 KiB per call by default; the result now contains `size`, `offset`, `length`, `truncated` and `nextOffset` (MCP clients reject tool results above 1 MB, ioBroker/ioBroker.mcp#63)

## 1.1.3 (2026-09-03)
* (ioBroker-Bot) Adapter requires admin >= 7.8.23 now.
* (@GermanBluefox) Updated packages

## 1.1.2 (2026-08-26)
* (@GermanBluefox) Node.js 22 is required now
* (@GermanBluefox) Corrected OAuth page

## 1.1.0 (2026-08-04)
* (@GermanBluefox) Added OAuth: MCP clients can now be connected through a browser login instead of a manually created token
* (@GermanBluefox) OAuth also works as a web extension, using the host `web` instance as the authorization server (requires OAuth enabled there too)
* (@GermanBluefox) Updated `@iobroker/mcp-server` and `@iobroker/webserver`

## 1.0.11 (2026-07-02)
* (@GermanBluefox) Default port was changed to 8011
* (@GermanBluefox) Corrected the issue with authentication

## 1.0.8 (2026-06-18)
* (@GermanBluefox) Used `@iobroker/mcp-server` package

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
