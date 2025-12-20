# Workflowy Local MCP

A local MCP server that lets LLMs read and write to your Workflowy account.

## Features

- **12 tools** for managing Workflowy nodes (create, update, delete, move, complete)
- **Local cache** with fast full-text search across all your nodes
- **Bookmarks** to save frequently-used node locations
- **Customizable** tool descriptions to tune AI behavior
- **Auto-sync** keeps cache fresh (syncs on startup if stale >1 hour)
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
| `save_bookmark` | Save a node ID with a friendly name |
| `list_bookmarks` | List all saved bookmarks |
| `delete_bookmark` | Delete a bookmark |
| `get_node_tree` | Get a node and its nested children from the local cache |
| `get_targets` | Get special locations (inbox, home) |
| `create_node` | Create a new node |
| `update_node` | Update a node's name or note |
| `delete_node` | Delete a node and all its children |
| `move_node` | Move a node to a new parent |
| `set_completed` | Set a node's completed status (checked/unchecked) |
| `search_nodes` | Search locally cached nodes by text |
| `sync_nodes` | Sync all nodes to local cache (1 req/min rate limit) |

## How It Works

The server maintains a local SQLite cache of all your Workflowy nodes for fast searching:

- **Auto-sync on startup**: If the cache is empty or stale (>1 hour), it syncs automatically
- **Optimistic updates**: Create, update, delete, move, and complete operations update the cache immediately
- **Full-text search**: `search_nodes` searches both node names and notes, returning results with breadcrumb paths
- **Rate limiting**: The Workflowy API limits exports to 1 request per minute

## Building from Source

Requires Node.js 18+ and Rust.

```bash
npm install
npm run tauri build
```
