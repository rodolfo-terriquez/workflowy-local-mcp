# Workflowy Local MCP - Implementation Status

*Last updated: February 4, 2026*

## Status: FULLY IMPLEMENTED

All planned enhancements have been successfully implemented and are production-ready. The system features:
- 10 streamlined MCP tools with comprehensive capabilities
- Search with child previews for intelligent result selection
- Bookmarks with LLM-written context notes
- Auto-sync with staleness detection and rate limiting
- **Selective sync-on-access** for always-fresh data
- **AI Instructions system** for user-customizable LLM behavior
- Full desktop UI for configuration and management
- Automatic database migrations for seamless upgrades
- **Shared JSON logging** - MCP server logs visible in app's Logs tab

---

## The Problem

Workflowy's data structure is fundamentally different from what LLMs expect. Instead of files in folders with markdown content, Workflowy is **one giant outline of infinitely nested bullets**. This creates several challenges:

1. **No inherent types** - A bullet could be a project, task, note, folder, or random thought. Users arbitrarily decide what each level represents.
2. **No search API** - Workflowy's API has no search endpoint, so we must cache and search locally.
3. **Context is positional** - Meaning comes from *where* a node sits in the tree, not just what it says.
4. **Scale** - Users can have 200k+ items (some over 1 million).

## Design Philosophy

**Keep it simple.** Rather than building complex classification systems to pre-determine what everything "is", we give the LLM a few powerful tools and let it make multiple calls to figure things out contextually. A few extra tool calls is better than a complex preprocessing system that guesses wrong.

**Search is the primary discovery mechanism.** The LLM doesn't know where anything is initially. Search with rich previews lets it quickly evaluate which results are relevant.

**Bookmarks are LLM memory.** Once the LLM finds something important, it can bookmark it with context notes for future sessions. Over time, this builds up a map of the user's structure.

**User instructions live in Workflowy.** Instead of config files, users can create an "AI Instructions" node in their Workflowy to customize LLM behavior. The LLM reads these at the start of each session.

## Current Implementation

**Project repository:** https://github.com/rodolfo-terriquez/workflowy-local-mcp

**Tech stack:**
- **Desktop app**: Tauri (React frontend + Rust backend)
- **MCP server**: TypeScript (Node.js)
- **Database**: SQLite with LIKE-based full-text search (sql.js doesn't support FTS5)
- **Current tools**: 10 streamlined tools for CRUD, search, bookmarks, and sync

**Implemented features:**
- Full export sync from Workflowy API (respects 1 req/min rate limit)
- SQLite caching with automatic migrations
- Search with child previews (first 5 children + counts)
- Bookmark system with context notes
- Auto-sync on startup and conversation start (if cache stale >1 hour)
- **Selective sync-on-access** using `/api/v1/nodes` endpoint (no rate limit)
- Optimistic cache updates for write operations
- Rate limiting with cooldown tracking
- Background sync with status tracking
- **AI Instructions system** for user-customizable behavior
- Full UI for managing bookmarks and cache

---

## Key Features

### Feature 1: AI Instructions System IMPLEMENTED

**The problem:** LLMs don't automatically know how to interact with a user's Workflowy. Different users have different organizational systems, preferences, and conventions. Without guidance, the LLM might create duplicates (e.g., new date nodes when calendar dates already exist) or format things incorrectly.

**The solution:** Users create an "AI Instructions" node in their Workflowy with custom preferences. The LLM reads these automatically at the start of each session.

**How it works:**

1. **User creates a node** called "AI Instructions" anywhere in their Workflowy
2. **User adds child nodes** with preferences like:
   - "Always add new tasks to my #inbox"
   - "Use checkboxes [ ] for tasks, not bullets"
   - "My calendar is under 'Daily Notes > 2026'"
   - "Never modify nodes under 'Archive'"
3. **LLM saves it as bookmark** named `ai_instructions` (reserved name)
4. **Every session**, LLM calls `list_bookmarks` first, which returns:
   - `_instructions`: Tells LLM to read user_instructions
   - `user_instructions`: The actual custom instructions
   - `action_required`: If no bookmark exists, tells LLM to search for it

**Implementation details:**

The `list_bookmarks` tool is configured to be called first every session:

```typescript
{
  name: "list_bookmarks",
  description: `**START EVERY CONVERSATION BY CALLING THIS TOOL.** This returns saved Workflowy locations AND the user's custom AI instructions.

The response contains:
- bookmarks: Saved node locations with context notes
- user_instructions: The user's custom preferences (if they have an 'ai_instructions' bookmark)

IMPORTANT: If user_instructions exists in the response, follow those preferences for the entire conversation.`
}
```

The response always includes guidance:

```json
{
  "_instructions": "READ THIS FIRST: Check user_instructions below for the user's custom AI preferences. Follow them for this entire conversation.",
  "bookmarks": [...],
  "user_instructions": "- Always add tasks to inbox\n- Use checkboxes for todos",
  // OR if not set up yet:
  "action_required": "No 'ai_instructions' bookmark found. Search for a node named 'AI Instructions' in Workflowy using search_nodes. If found, read it with get_node_tree and save it as bookmark 'ai_instructions' for future sessions."
}
```

**Key implementation locations:**
- Reserved bookmark name constant: `mcp-server/server.ts` line 191
- `getAIInstructions()` function: `mcp-server/server.ts` lines 828-878
- `list_bookmarks` response building: `mcp-server/server.ts` lines 1421-1466
- Tool description: `mcp-server/server.ts` lines 953-965

**Why this approach works:**

1. **Tool descriptions are always read** - Unlike server instructions or prompts, LLMs always see tool descriptions
2. **`list_bookmarks` is naturally called first** - The description makes this explicit
3. **Response contains clear guidance** - The `_instructions` field is impossible to miss
4. **Graceful degradation** - If no instructions exist, `action_required` tells the LLM what to do

**Lessons learned (important for avoiding regressions):**

- MCP `server.instructions` field is NOT reliably read by all clients
- MCP prompts (like `server_instructions`) are NOT automatically fetched
- The ONLY reliable way to communicate with LLMs is through tool descriptions and tool responses
- Tool descriptions should be explicit: "START EVERY CONVERSATION BY CALLING THIS TOOL"
- Tool responses should include guidance fields that the LLM can't miss

---

### Feature 2: Selective Sync-on-Access IMPLEMENTED

**The problem:** The full export endpoint (`/nodes-export`) has a 1 request/minute rate limit, but users expect fresh data when they access nodes. Waiting for full syncs means stale data.

**The solution:** Use the `/api/v1/nodes?parent_id=X` endpoint (no rate limit) to sync specific nodes when they're accessed.

**Implementation:**

Two new functions handle selective sync:

```typescript
// Sync a single node
async function syncSingleNode(apiKey, db, nodeId)

// Sync children of a node (1 level only - NOT recursive)
async function syncNodeChildren(apiKey, db, parentId)
```

**When sync happens:**

| Tool | Sync Action | Blocking? |
|------|-------------|-----------|
| `list_bookmarks` | Sync `ai_instructions` bookmark's children | Yes (awaited) |
| `list_bookmarks` | Sync other bookmarked nodes' children | No (background) |
| `get_node_tree` | Sync requested node's children | Yes (awaited) |
| `create_node` | Sync parent's children after creation | No (background) |
| `update_node` | Sync the updated node | No (background) |
| `delete_node` | Sync parent's children after deletion | No (background) |
| `move_node` | Sync both old and new parent's children | No (background) |

**Key design decisions:**

1. **1 level only** - Never recursive to avoid thousands of API calls
2. **Awaited for reads** - `get_node_tree` and `ai_instructions` wait for sync to complete
3. **Background for writes** - Write operations fire-and-forget so they don't block
4. **No rate limit** - These endpoints aren't rate-limited like `/nodes-export`

**Implementation locations:**
- `syncSingleNode()`: `mcp-server/server.ts` lines 504-570
- `syncNodeChildren()`: `mcp-server/server.ts` lines 573-686
- `deleteNodeFromCache()`: `mcp-server/server.ts` lines 689-704
- Integration in tool handlers: throughout the switch statement

---

### Feature 3: Search Results with Child Previews IMPLEMENTED

**The solution:** Search results include a preview of children so the LLM can evaluate relevance in one call.

**Example response:**

```json
{
  "node_id": "abc-123",
  "name": "Today's Tasks",
  "path": "Home > Daily > Today's Tasks",
  "note": null,
  "completed": false,
  "children_count": 12,
  "children_preview": [
    { "name": "[ ] Fix header bug", "children_count": 0 },
    { "name": "[ ] Review PR #123", "children_count": 2 },
    { "name": "[ ] Email Sarah", "children_count": 0 }
  ]
}
```

**How it works:**
- `children_count` tells the LLM how "big" this node is
- `children_preview` (first 5) shows what kind of content is inside
- Each preview item's `children_count` indicates depth/complexity
- Children are ordered by `priority` field from Workflowy API

**Default limit:** 5 results (configurable up to 100)

---

### Feature 4: Bookmark Context Field IMPLEMENTED

**The solution:** Bookmarks include a `context` field where the LLM writes notes for its future self.

**Bookmark format:**
```json
{
  "name": "Daily Tasks",
  "node_id": "abc-123",
  "created_at": "2026-01-30",
  "context": "User's daily todo list. Items formatted as [ ] for incomplete, [x] for complete. Check here first when user asks about tasks or todos."
}
```

**Benefits:**
- LLM builds up knowledge of user's structure over time
- Future sessions start with context instead of cold-searching
- Context is LLM-written, for LLMs - optimized for their understanding

---

### Feature 5: Calendar/Date Node Handling IMPLEMENTED

**The problem:** Workflowy's calendar system auto-creates date nodes with varying formats ("Jan 15, 2025", "Today - Jan 15", etc.). LLMs were creating duplicate date nodes instead of adding to existing ones.

**The solution:** Server instructions explicitly warn about this:

```
## Calendar & Date Nodes
Workflowy has a calendar system that auto-creates date nodes (e.g., "Jan 15, 2025", "Today - Jan 15", "Tomorrow - Jan 16"). These date nodes may have prefixes like "Today", "Yesterday", "Tomorrow" depending on user preferences.

**CRITICAL: Always search before creating date-related content.**
- Before adding items to a date, ALWAYS search for that date first
- Date nodes may appear with different text - they are the SAME node
- If a date node exists, use update_node or create_node with that node as parent
- When searching for dates, try multiple formats
```

---

## Current Tool Set

| Tool | Purpose |
|------|---------|
| `list_bookmarks` | **START HERE** - Returns bookmarks + user's AI instructions |
| `search_nodes` | LIKE-based search with child previews (first 5 + counts) |
| `get_node_tree` | Get a node + children to depth N (max 10) |
| `save_bookmark` | Save node with label + LLM-written context |
| `delete_bookmark` | Delete a bookmark by name |
| `create_node` | Create new node (supports multiline markdown) |
| `update_node` | Edit node name/note/completed status |
| `move_node` | Move node to new parent |
| `delete_node` | Delete node and descendants |
| `sync_nodes` | Force refresh cache from Workflowy API |

**10 tools total.**

---

## Workflowy API Reference

**Endpoint:** `https://beta.workflowy.com/api-reference/`

**Key endpoints:**
- `GET /api/v1/nodes-export` - Export ALL nodes. **Rate limit: 1/minute**
- `GET /api/v1/nodes?parent_id=X` - List children of a node. **No rate limit**
- `GET /api/v1/nodes/:id` - Get single node. **No rate limit**
- `POST /api/v1/nodes` - Create node
- `POST /api/v1/nodes/:id` - Update node
- `DELETE /api/v1/nodes/:id` - Delete node
- `POST /api/v1/nodes/:id/move` - Move node
- `POST /api/v1/nodes/:id/complete` - Mark complete
- `POST /api/v1/nodes/:id/uncomplete` - Mark incomplete

**Auth:** Bearer token in Authorization header

---

## Auto-Sync Behavior

| Trigger | What Syncs | Rate Limited? |
|---------|------------|---------------|
| Server startup | `ai_instructions` bookmark children | No |
| Conversation start | Full sync if cache >1 hour old | Yes (1/min) |
| `list_bookmarks` call | All bookmarked nodes' children | No |
| `get_node_tree` call | Requested node's children | No |
| After write operations | Affected nodes' children | No |

---

## Implementation Lessons (Regression Prevention)

### How to Reliably Communicate Instructions to LLMs

**What DOESN'T work reliably:**
- MCP `server.instructions` field - Not all clients read it
- MCP prompts - Clients don't automatically fetch them
- Assuming LLMs will read documentation

**What DOES work:**
1. **Tool descriptions** - Always read by LLMs before calling tools
2. **Tool response fields** - LLMs read the data they receive
3. **Explicit instructions** in both places

**Pattern for critical instructions:**

```typescript
// In tool description:
description: `**START EVERY CONVERSATION BY CALLING THIS TOOL.** ...`

// In tool response:
return {
  _instructions: "READ THIS FIRST: ...",
  data: ...,
  action_required: "If X is missing, do Y"
}
```

### Sync-on-Access Pattern

**Problem:** Full syncs are rate-limited and slow
**Solution:** Use selective sync endpoints for specific nodes

**Key rules:**
1. **Never recursive** - Only sync 1 level of children
2. **Await for reads** - Ensure fresh data before returning
3. **Background for writes** - Don't block the response
4. **Handle missing nodes** - API returns 404 for deleted nodes

### Reserved Bookmark Names

The `ai_instructions` bookmark name is reserved for the AI Instructions feature. The system:
1. Looks for this bookmark specifically
2. Syncs its children before reading
3. Includes its content in `list_bookmarks` response

### Shared JSON Logging

**Problem:** MCP server logs only went to stderr, invisible to users in the app.

**Solution:** MCP server writes logs to a shared JSON file that the app reads and displays.

**How it works:**

1. **MCP server writes logs** to `mcp-logs.json` in the app's data directory:
   ```typescript
   function writeMcpLog(message: string, type: "info" | "success" | "error" | "warning"): void
   ```

2. **Log format:**
   ```json
   {
     "timestamp": "2026-02-04T10:30:00.000Z",
     "message": "Background sync complete: 150 nodes synced",
     "type": "success",
     "source": "mcp"
   }
   ```

3. **Rust backend** provides `get_mcp_logs` command to read the file

4. **React UI** merges MCP logs with app logs, sorted by timestamp

**Key features:**
- Keeps last 200 log entries (auto-truncates)
- Auto-refresh every 3 seconds while on Logs tab
- Manual refresh button available
- Logs show source badge: `[APP]` or `[MCP]`
- Color-coded by type: info (blue), success (green), warning (yellow), error (red)

**Implementation locations:**
- `writeMcpLog()`: `mcp-server/server.ts` lines 192-228
- `McpLogEntry` struct: `src-tauri/src/lib.rs` lines 74-80
- `get_mcp_logs` command: `src-tauri/src/lib.rs` lines 199-214
- UI integration: `src/App.tsx` Logs section

---

## Development Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/rodolfo-terriquez/workflowy-local-mcp
   cd workflowy-local-mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the MCP server:
   ```bash
   npm run build:mcp
   ```

4. Build the Tauri app:
   ```bash
   npm run tauri build
   ```

5. Run in development mode:
   ```bash
   npm run tauri dev
   ```

---

## Key Files

| File | Purpose |
|------|---------|
| `mcp-server/server.ts` | MCP server with all tools and cache logic |
| `src-tauri/src/lib.rs` | Rust backend for Tauri app |
| `src/App.tsx` | React UI for configuration and management |

---

## Success Criteria

- Search results include `children_count` and `children_preview`
- Bookmarks have `context` field that LLM can write to
- `list_bookmarks` returns context + user's AI instructions
- LLM calls `list_bookmarks` first in every conversation
- User's AI Instructions are loaded and followed
- Selective sync keeps data fresh without rate limit issues
- Calendar/date nodes aren't duplicated
- All functionality works with automatic migrations
- Auto-sync on startup for stale caches
- Optimistic cache updates for write operations
- Rate limiting properly enforced
- MCP logs appear in app's Logs tab with auto-refresh
