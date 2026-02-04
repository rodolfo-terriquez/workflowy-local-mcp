# Workflowy Local MCP - Implementation Status

*Last updated: February 3, 2026*

## Status: ✅ FULLY IMPLEMENTED

All planned enhancements have been successfully implemented and are production-ready. The system features:
- 10 streamlined MCP tools with comprehensive capabilities
- Search with child previews for intelligent result selection
- Bookmarks with LLM-written context notes
- Auto-sync with staleness detection and rate limiting
- Full desktop UI for configuration and management
- Automatic database migrations for seamless upgrades

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

## Current Implementation

**Project repository:** https://github.com/rodolfo-terriquez/workflowy-local-mcp

**Tech stack:**
- **Desktop app**: Tauri (React frontend + Rust backend)
- **MCP server**: TypeScript (Node.js)
- **Database**: SQLite with LIKE-based full-text search (sql.js doesn't support FTS5)
- **Current tools**: 10 streamlined tools for CRUD, search, bookmarks, and sync

**Implemented features:**
- ✅ Full export sync from Workflowy API (respects 1 req/min rate limit)
- ✅ SQLite caching with automatic migrations
- ✅ Search with child previews (first 5 children + counts)
- ✅ Bookmark system with context notes
- ✅ Auto-sync on startup (if cache stale >1 hour)
- ✅ Optimistic cache updates for write operations
- ✅ Rate limiting with cooldown tracking
- ✅ Background sync with status tracking
- ✅ Full UI for managing bookmarks and cache

## Key Features

### Feature 1: Search Results with Child Previews ✅ IMPLEMENTED

**The solution:** Search results include a preview of children so the LLM can evaluate relevance in one call.

**Implementation location:** `mcp-server/server.ts` lines 1264-1383

**Example workflow - User asks "What are my tasks for today?"**

```
LLM calls: search("tasks today")

Results returned:
─────────────────────────────────────────────────────────
1. "Today's Tasks"
   Path: Home › Daily › Today's Tasks
   Children: 5 of 12 shown
     • [ ] Fix header bug (0 children)
     • [ ] Review PR #123 (2 children)
     • [ ] Email Sarah (0 children)
     • [ ] Update docs (5 children)
     • [ ] Deploy staging (0 children)
   ...7 more
─────────────────────────────────────────────────────────
2. "Tasks"
   Path: Home › Archive › Old Project › Tasks
   Children: none
─────────────────────────────────────────────────────────
```

The LLM immediately sees: Result #1 has actual tasks with checkbox formatting. Result #2 is empty and buried in Archive. **One tool call, obvious next step.**

**Data format:**
```json
{
  "node_id": "abc-123",
  "name": "Today's Tasks",
  "path": "Home › Daily › Today's Tasks",
  "note": null,
  "completed": false,
  "children_count": 12,
  "children_preview": [
    { "name": "[ ] Fix header bug", "children_count": 0 },
    { "name": "[ ] Review PR #123", "children_count": 2 },
    { "name": "[ ] Email Sarah", "children_count": 0 },
    { "name": "[ ] Update docs", "children_count": 5 },
    { "name": "[ ] Deploy staging", "children_count": 0 }
  ]
}
```

**How it works:**
- `children_count` tells the LLM how "big" this node is
- `children_preview` (first 5) shows what kind of content is inside
- Each preview item's `children_count` indicates depth/complexity
- Children are ordered by `priority` field from Workflowy API
- LLM can make informed decisions without additional reads

### Feature 2: Bookmark Context Field ✅ IMPLEMENTED

**The solution:** Bookmarks include a `context` field where the LLM writes notes for its future self.

**Implementation locations:**
- MCP server: `mcp-server/server.ts` lines 87-104 (schema), 653-676 (save), 985-1001 (list)
- Rust backend: `src-tauri/src/lib.rs` lines 65-177
- React UI: `src/App.tsx` lines 964-1066

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
- Context is editable via both MCP tools and the desktop UI

### Typical Workflows

```
User: "What are my tasks for today?"

┌─────────────────────────────────────────────────────────┐
│ Step 1: list_bookmarks()                                │
│   → Returns bookmarks with context                      │
│   → LLM sees "Daily Tasks" bookmark with context        │
│   → Skips search, goes directly to known location       │
├─────────────────────────────────────────────────────────┤
│ Step 2: read(node_id="abc-123", depth=2)                │
│   → Gets the node and 2 levels of children              │
│   → Returns full task list                              │
├─────────────────────────────────────────────────────────┤
│ Step 3: Answer user's question                          │
│   → "You have 5 tasks for today: ..."                   │
└─────────────────────────────────────────────────────────┘

Total: 2 tool calls (because bookmark existed)
```

**First time (no bookmark):**

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: list_bookmarks()                                │
│   → Empty or no relevant bookmark                       │
├─────────────────────────────────────────────────────────┤
│ Step 2: search("tasks today")                           │
│   → Returns matches with child previews                 │
│   → LLM picks best match based on preview content       │
├─────────────────────────────────────────────────────────┤
│ Step 3: read(node_id, depth=2)                          │
│   → Gets full content                                   │
├─────────────────────────────────────────────────────────┤
│ Step 4: add_bookmark(node_id, "Daily Tasks", context)   │
│   → Saves for next time                                 │
├─────────────────────────────────────────────────────────┤
│ Step 5: Answer user's question                          │
└─────────────────────────────────────────────────────────┘

Total: 4 tool calls (first time), 2 calls thereafter
```

## Current Tool Set

| Tool | Purpose | Implementation |
|------|---------|----------------|
| `search_nodes` | LIKE-based search → matches with child previews (first 5 + counts) | lines 1264-1383 |
| `get_node_tree` | Get a node + children to depth N (max 10) | lines 1025-1108 |
| `list_bookmarks` | Return all bookmarks with context notes | lines 985-1001 |
| `save_bookmark` | Save node with label + LLM-written context | lines 962-983 |
| `delete_bookmark` | Delete a bookmark by name | lines 1003-1022 |
| `create_node` | Create new node (API passthrough + optimistic cache update) | lines 1111-1144 |
| `update_node` | Edit node name/note/completed status (handles complete/uncomplete) | lines 1146-1214 |
| `move_node` | Move node to new parent (API passthrough + cache update) | lines 1236-1261 |
| `delete_node` | Delete node and descendants (API + recursive cache deletion) | lines 1216-1234 |
| `sync_nodes` | Force refresh cache from Workflowy API | lines 1385-1395 |

**10 tools total.** Consolidated from the initial design by merging completion status into `update_node`.

## Additional Features Implemented

Beyond the core enhancements, the implementation includes:

### Priority-Based Child Ordering
Children are ordered by Workflowy's `priority` field, preserving the user's intended ordering. This ensures child previews show items in the same order as they appear in Workflowy.

### Comprehensive UI
The Tauri desktop app provides:
- **API Key Management** - Validation and secure storage
- **Bookmarks Tab** - View, edit context, and delete bookmarks
- **Cache Status** - View sync status, node count, and freshness
- **Manual Sync** - Force sync with rate limit countdown
- **Tool Customization** - Edit server instructions and tool descriptions
- **Setup Instructions** - Copy-paste config for Claude Code, Claude Desktop, and Cursor
- **Activity Logs** - Real-time logging of operations

### Robust Error Handling
- Transaction rollback on sync failures
- Graceful handling of missing nodes
- Prevention of infinite loops in tree traversal
- Validation of API keys before operations

### Path Building
Search results include both a full path array and a formatted display path with smart truncation for deeply nested nodes (e.g., "Root > ... > Parent > Node").

## Workflowy API Reference

**Endpoint:** `https://beta.workflowy.com/api-reference/`

**Key endpoints:**
- `GET /api/v1/nodes-export` - Export ALL nodes (has `parent_id` field). **Rate limit: 1/minute**
- `GET /api/v1/nodes/:id` - Get single node
- `POST /api/v1/nodes` - Create node
- `POST /api/v1/nodes/:id` - Update node
- `DELETE /api/v1/nodes/:id` - Delete node
- `POST /api/v1/nodes/:id/move` - Move node

**Node object fields:**
- `id` - UUID
- `name` - Main text (supports markdown formatting)
- `note` - Additional content
- `parent_id` - Reference to parent
- `priority` - Sort order among siblings
- `createdAt`, `modifiedAt` - Unix timestamps
- `completedAt` - Null if incomplete
- `layoutMode` - Display style (bullets, todo, h1, h2, h3, code-block, quote-block)

**Auth:** Bearer token in Authorization header

## Implementation Details

### SQLite Schema

**Bookmarks table:**
```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  name TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  context TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)
```

**Nodes cache table:**
```sql
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  note TEXT DEFAULT '',
  parent_id TEXT,
  completed INTEGER DEFAULT 0,
  children_count INTEGER DEFAULT 0,
  priority INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
)
```

**Indexes for performance:**
- `idx_nodes_parent_id` - For hierarchical queries
- `idx_nodes_completed` - For filtering completed items
- `idx_nodes_priority` - For ordering children by priority
- `idx_nodes_name` - For LIKE-based search
- `idx_nodes_note` - For note search

### Automatic Migrations

Both TypeScript (`server.ts` lines 98-157) and Rust (`lib.rs` lines 73-93) backends include migration logic to add missing columns to existing databases, ensuring seamless upgrades.

### Search Implementation

Since sql.js doesn't support FTS5, search uses `UPPER(name) LIKE ?` and `UPPER(note) LIKE ?` with indexes for reasonable performance. The pattern matching approach works well for typical use cases (few thousand to hundreds of thousands of nodes).

### Auto-Sync Behavior

- **On startup:** Background sync if cache is >1 hour old (lines 1407-1447)
- **On read operations:** Auto-check freshness and sync if needed (lines 459-499)
- **Rate limiting:** Respects Workflowy's 1 req/min limit with cooldown tracking
- **In-progress check:** Prevents concurrent sync operations

### Optimistic Cache Updates

Write operations (create, update, move, delete) immediately update the local cache after successful API calls, keeping the cache in sync without requiring a full refresh.

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

## Key Files

| File | Purpose | Lines of Code |
|------|---------|---------------|
| `mcp-server/server.ts` | MCP server with all tools and cache logic | 1,451 |
| `src-tauri/src/lib.rs` | Rust backend for Tauri app | 204 |
| `src/App.tsx` | React UI for configuration and management | 1,188 |
| `src/App.css` | Styles for the desktop app | ~500 |

## Success Criteria ✅

- ✅ Search results include `children_count` and `children_preview` (first 5 children with their counts)
- ✅ Bookmarks have `context` field that LLM can write to
- ✅ `list_bookmarks` returns context with full details
- ✅ UI displays and allows editing bookmark context with save/cancel actions
- ✅ LLM can effectively choose between search results based on previews
- ✅ Tool count reduced to exactly 10
- ✅ All functionality works with automatic migrations
- ✅ Auto-sync on startup for stale caches
- ✅ Optimistic cache updates for write operations
- ✅ Rate limiting properly enforced
