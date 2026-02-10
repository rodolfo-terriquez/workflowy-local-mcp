# Workflowy Local MCP

A desktop app that runs a local MCP server, letting LLMs read and write to your Workflowy account. Your API key stays on your machine.

## Features

- **10 tools** for managing Workflowy nodes (create, update, delete, move, search, sync)
- **Local SQLite cache** with fast full-text search across all your nodes
- **Bookmarks** to save frequently-used node locations with context notes
- **AI Instructions** — create an "AI Instructions" node in Workflowy to customize LLM behavior across sessions
- **Sync-on-access** — reads auto-sync from the Workflowy API so data is always fresh
- **Customizable** server instructions and tool descriptions to tune AI behavior
- **MCP logging** — view server activity in the desktop app in real time
- **Fully local** — your API key never leaves your machine

## Installation

1. Download the latest release from [GitHub Releases](../../releases)
   - **macOS**: `.dmg` file
   - **Windows**: `.msi` or `.exe` installer

2. **macOS users**: The app is unsigned, so you'll need to bypass Gatekeeper:
   - **Option 1**: Right-click the app → select "Open" → click "Open" in the dialog
   - **Option 2**: Run `xattr -cr /path/to/Workflowy\ Local\ MCP.app` in Terminal
   - If you see "damaged and can't be opened", use Option 2

3. Open the app and enter your Workflowy API key
   - Get one at [workflowy.com/api-reference](https://beta.workflowy.com/api-reference/)

4. Go to the **Setup** tab and follow the instructions for your MCP client (Claude Code, Claude Desktop, Cursor, or any app that supports MCP)

5. Restart your MCP client — the Workflowy tools are now available

## Available Tools

| Tool | Description |
|------|-------------|
| `list_bookmarks` | List all saved bookmarks and the user's custom AI instructions. Intended to be called at the start of every conversation. |
| `save_bookmark` | Save a node ID with a friendly name and context notes for future sessions |
| `delete_bookmark` | Delete a saved bookmark by name |
| `get_node_tree` | Get a node and its nested children with configurable depth (1-10). Supports `compact` (markdown) and `json` output formats. Auto-syncs fresh data from the API. |
| `create_node` | Create a new node. Supports multiline markdown to create entire nested structures in one call. Accepts special `parent_id` values: `inbox`, `home`, or `None` (top-level). |
| `update_node` | Update a node's name, note, or completed status (checked/unchecked) |
| `delete_node` | Permanently delete a node and all its children |
| `move_node` | Move a node to a different parent. Accepts special `parent_id` values: `inbox`, `home`, or `None` (top-level). |
| `search_nodes` | Search locally cached nodes by text. Returns results with breadcrumb paths and a preview of each result's children. |
| `sync_nodes` | Full sync of all Workflowy nodes to local cache (rate limited to 1 request per minute) |

## How It Works

The server maintains a local SQLite cache of all your Workflowy nodes:

- **Auto-sync on startup**: If the cache is empty or stale (>1 hour), a background sync runs automatically
- **Sync-on-access**: `get_node_tree` syncs the requested node's children (up to 2 levels deep) from the API before returning, so you always see fresh data
- **Optimistic updates**: Write operations (create, update, delete, move) update the cache immediately, then sync in the background to confirm the change
- **Full-text search**: `search_nodes` searches both node names and notes, returning results with breadcrumb paths and child previews
- **Rate limiting**: The Workflowy `nodes-export` API is limited to 1 request per minute; individual node syncs are not rate-limited

## Desktop App

The Tauri-based desktop app provides a UI for configuration and monitoring:

- **API Key** — enter and validate your Workflowy API key
- **Tools** — customize server instructions and individual tool descriptions to tune AI behavior
- **Setup** — copy-paste configuration snippets for Claude Code, Claude Desktop, and Cursor
- **Bookmarks** — view, edit context, and delete saved bookmarks
- **Cache** — view cache status and trigger a manual sync
- **Logs** — view MCP server logs in real time (auto-refreshes every 3 seconds)

## AI Instructions

You can create a node called "AI Instructions" in Workflowy to set persistent preferences for how LLMs interact with your data. For example:

- "Always add new tasks to my #inbox"
- "Use checkboxes for tasks, not bullets"
- "My calendar is under 'Daily Notes > 2025'"

The LLM will search for this node, save it as a reserved `ai_instructions` bookmark, and automatically load it at the start of every conversation.

## Data Storage

All data is stored locally in the app data directory:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/com.workflowy.local-mcp/` |
| Windows | `%APPDATA%\com.workflowy.local-mcp\` |
| Linux | `~/.local/share/com.workflowy.local-mcp/` |

Files stored: `config.json` (settings), `bookmarks.db` (SQLite database with bookmarks and node cache), `mcp-logs.json` (server logs).

The API key can also be set via the `WORKFLOWY_API_KEY` environment variable instead of the app config.

## Building from Source

Requires Node.js 18+ and Rust.

```bash
npm install
npm run tauri build
```

This runs the frontend build (`tsc && vite build`), bundles the MCP server with esbuild (`npm run build:mcp`), and packages everything into a Tauri desktop app.
