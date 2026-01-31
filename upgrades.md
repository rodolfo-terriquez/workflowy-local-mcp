# Workflowy Local MCP - Enhancement Plan

*Last updated: January 30, 2026*

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

## Existing Codebase

We're enhancing the existing project: https://github.com/rodolfo-terriquez/workflowy-local-mcp

**Current tech stack:**
- **Desktop app**: Tauri (React frontend + Rust backend)
- **MCP server**: TypeScript (Node.js)
- **Database**: SQLite with FTS5 for full-text search
- **Current tools**: 14 tools for CRUD, search, bookmarks, sync

**What already works:**
- Full export sync from Workflowy API (respects 1 req/min rate limit)
- SQLite caching with full-text search
- Basic bookmark system (name → node_id)
- Sync staleness detection (auto-refresh if >1 hour old)

## Key Enhancements

### Enhancement 1: Search Results with Child Previews

**The problem:** Current search returns matches with their path, but the LLM can't tell which result is actually useful without reading each one.

**The solution:** Include a preview of children in search results so the LLM can evaluate relevance in one call.

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

**Why this works:**
- `children_count` tells the LLM how "big" this node is
- `children_preview` (first 5) shows what kind of content is inside
- Each preview item's `children_count` indicates depth/complexity
- LLM can make informed decisions without additional reads

### Enhancement 2: Bookmark Context Field

**The problem:** Current bookmarks are just name → node_id mappings. The LLM knows *where* something is but not *what it contains* or *how to use it*.

**The solution:** Add a `context` field where the LLM writes notes for its future self.

**Current bookmark format:**
```json
{
  "name": "Daily Tasks",
  "node_id": "abc-123",
  "created_at": "2026-01-30"
}
```

**Enhanced bookmark format:**
```json
{
  "name": "Daily Tasks",
  "node_id": "abc-123",
  "created_at": "2026-01-30",
  "context": "User's daily todo list. Items formatted as [ ] for incomplete, [x] for complete. Check here first when user asks about tasks or todos."
}
```

**Why this works:**
- LLM builds up knowledge of user's structure over time
- Future sessions start with context instead of cold-searching
- Context is LLM-written, for LLMs - optimized for their understanding

### Typical Workflow After Enhancements

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

## Final Tool Set

| Tool | Purpose |
|------|---------|
| `search` | FTS query → matches with child previews (first 5 children + counts) |
| `read` | Get a node + children to depth N |
| `list_bookmarks` | Return all bookmarks with context |
| `add_bookmark` | Save node with label + LLM-written context |
| `remove_bookmark` | Delete a bookmark |
| `create` | Create new node (API passthrough) |
| `update` | Edit node name/note (API passthrough) |
| `move` | Move node to new parent (API passthrough) |
| `delete` | Delete node (API passthrough) |
| `sync` | Force refresh cache from Workflowy API |

**10 tools total.** Down from 14 in the current implementation.

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

## Implementation Steps

### Step 1: Set up development environment
- Clone https://github.com/rodolfo-terriquez/workflowy-local-mcp
- Install Node.js 18+ and Rust compiler
- Run `npm install`
- Verify build with `npm run build`

### Step 2: Enhance SQLite schema
**In `mcp-server/server.ts`:**

Add `children_count` column to nodes table:
```sql
ALTER TABLE nodes ADD COLUMN children_count INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
```

Update sync logic to compute children counts after populating nodes:
```sql
UPDATE nodes SET children_count = (
  SELECT COUNT(*) FROM nodes AS children
  WHERE children.parent_id = nodes.id
);
```

### Step 3: Enhance search results
**In `mcp-server/server.ts`, modify `search_nodes` tool:**

After getting search matches, for each result:
1. Query first 5 children: `SELECT id, name, children_count FROM nodes WHERE parent_id = ? ORDER BY position LIMIT 5`
2. Get total count: `SELECT COUNT(*) FROM nodes WHERE parent_id = ?`
3. Build `children_preview` array
4. Include in response

### Step 4: Enhance bookmark schema
**In `mcp-server/server.ts`:**

Update bookmarks table:
```sql
ALTER TABLE bookmarks ADD COLUMN context TEXT;
```

**In `save_bookmark` tool:**
- Add `context` parameter (optional string)
- Store in database

**In `list_bookmarks` tool:**
- Include `context` in response

### Step 5: Update Rust backend
**In `src-tauri/src/lib.rs`:**

Update `get_bookmarks` to return context field.
Update any bookmark-related structs.

### Step 6: Update React UI
**In `src/App.tsx`:**

In Bookmarks tab:
- Display context for each bookmark
- Add edit button to modify context
- Allow multi-line context editing

### Step 7: Consolidate tools (optional)
- Merge `set_description` into `update_node`
- Review `toggle_complete` - keep if useful, merge if not

### Step 8: Update tool descriptions
Rewrite MCP tool descriptions to explain:
- What child previews contain
- How to use previews for decision-making
- What bookmark context is for

## Files to Modify

| File | Changes |
|------|---------|
| `mcp-server/server.ts` | Search enhancement, bookmark context, schema changes, tool consolidation |
| `src-tauri/src/lib.rs` | Bookmark context in Rust handlers |
| `src/App.tsx` | Bookmark context UI |

## Success Criteria

- [ ] Search results include `children_count` and `children_preview` (first 5 children with their counts)
- [ ] Bookmarks have `context` field that LLM can write to
- [ ] `list_bookmarks` returns context
- [ ] UI displays and allows editing bookmark context
- [ ] LLM can effectively choose between search results based on previews
- [ ] Tool count reduced from 14 to ~10
- [ ] All existing functionality still works
