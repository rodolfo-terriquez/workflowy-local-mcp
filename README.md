# Workflowy Local MCP

A local MCP server that lets Claude Code, Claude Desktop, and Cursor read and write to your Workflowy account.

## Features

- **13 tools** for managing Workflowy nodes (create, update, delete, move, complete)
- **Bookmarks** to save frequently-used node locations
- **Customizable** tool descriptions to tune Claude's behavior
- **Fully local** — your API key never leaves your machine

## Installation

1. Download the latest release from [GitHub Releases](../../releases)
   - **macOS**: `.dmg` file
   - **Windows**: `.msi` or `.exe` installer

2. Open the app and enter your Workflowy API key
   - Get one at [workflowy.com/api-reference](https://beta.workflowy.com/api-reference/)

3. Go to the **Setup** tab and follow the instructions for your MCP client (Claude Code, Claude Desktop, Cursor, or any app that supports MCP)

4. Restart your MCP client — the Workflowy tools are now available

## Available Tools

| Tool | Description |
|------|-------------|
| `save_bookmark` | Save a node ID with a friendly name |
| `list_bookmarks` | List all saved bookmarks |
| `delete_bookmark` | Delete a bookmark |
| `list_nodes` | List children of a node |
| `get_node` | Get a single node by ID |
| `get_targets` | Get special locations (inbox, home) |
| `export_all_nodes` | Export all nodes (1 req/min limit) |
| `create_node` | Create a new node |
| `update_node` | Update a node's name or note |
| `delete_node` | Delete a node |
| `move_node` | Move a node to a new parent |
| `complete_node` | Mark a node as complete |
| `uncomplete_node` | Mark a node as incomplete |

## Building from Source

Requires Node.js 18+ and Rust.

```bash
npm install
npm run tauri build
```
