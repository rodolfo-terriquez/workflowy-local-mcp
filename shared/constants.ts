// Shared constants between the MCP server and the Tauri frontend
// This file is the single source of truth for default server instructions

export const defaultServerInstructions = `This MCP server connects to a user's Workflowy account. Workflowy is an outliner app where notes are organized as nested bullet points (nodes).

## STOP — Read This First

**Before making ANY tool call, follow this checklist:**

1. **Call list_bookmarks FIRST** — It returns saved locations (including the node IDs you need) AND the user's custom instructions. Skip this = wasted calls.

2. **One read, one edit** — Use read_doc to fetch a subtree, then edit_doc to make changes. You can batch multiple operations (insert, update, delete) in a single edit_doc call.

3. **Calendar shortcuts** — Use \`today\`, \`tomorrow\`, \`next_week\`, or \`inbox\` as node_id values. No need to search for date nodes.

4. **Workflowy links** — If user shares a link like \`https://beta.workflowy.com/#/b24b650a6b91\`, extract the 12-hex ID after \`#/\` and use that as \`node_id\`.

## Key Concepts
- Nodes are identified by 12-character hex tags (e.g., "b605f0e85a4a")
- Nodes can have: name (text), note/description (d), type (h1/h2/h3/todo/bullets/code/quote/table/p), completion status (x: 1 or 0)
- Children are nested in the "c" array
- Special targets: \`today\`, \`tomorrow\`, \`next_week\`, \`inbox\`, \`None\` (home/root)
- Calendar IDs are also valid node IDs: \`YYYY\`, \`YYYY-MM\`, \`YYYY-MM-DD\`

## read_doc Response Format

The API returns tag-as-key JSON. Example:
\`\`\`json
{
  "b605f0e85a4a": "My Project",
  "d": "Project description/note text",
  "c": [
    {"aa11bb22cc33": "Task 1", "l": "todo", "x": 1},
    {"dd44ee55ff66": "Task 2", "d": "Some note on this task", "l": "todo"},
    {"7788990011ab": "Notes", "c": [...], "+": 1}
  ],
  "ancestors": [{"None": "Home"}]
}
\`\`\`

- The first key-value is the node's tag and name
- \`d\` is the node's note/description text (only present if the node has a note)
- \`c\` contains children
- \`l\` is the line type (todo, h1, h2, h3, bullets, code, quote, table, p)
- \`x: 1\` means completed
- \`+: 1\` means there are more children below the depth limit
- Mirrors appear as \`{"<tag>": "Original Name", "m": "<original_short_id>", "c": [...]}\`: the \`m\` marker means this is a live mirror of another node, and the mirrored children are already included inline (no separate read needed)

## edit_doc Operations

**Insert** — Create new nodes:
\`\`\`json
{"op": "insert", "under": "today", "items": [{"n": "New task", "d": "Note text", "l": "todo"}], "position": "top"}
\`\`\`
Insert can also use \`"after": "<sibling-tag>"\` instead of \`under\` to place items after a specific sibling. Exactly one of \`under\` or \`after\` is required.

**Update** — Modify existing nodes (requires prior read):
\`\`\`json
{"op": "update", "ref": "aa11bb22cc33", "to": {"n": "Renamed", "d": "Updated note", "x": 1}}
\`\`\`

**Delete** — Remove nodes (requires prior read):
\`\`\`json
{"op": "delete", "ref": "aa11bb22cc33"}
\`\`\`

**Move** — Move a node (with all its children) to a new parent:
\`\`\`json
{"op": "move", "ref": "aa11bb22cc33", "under": "dd44ee55ff66", "position": "top"}
\`\`\`

**Batch operations** — Multiple operations in one call:
\`\`\`json
{
  "root": "b605f0e85a4a",
  "operations": [
    {"op": "update", "ref": "aa11bb22cc33", "to": {"x": 1}},
    {"op": "insert", "under": "aa11bb22cc33", "items": [{"n": "Sub-item"}], "position": "bottom"},
    {"op": "delete", "ref": "dd44ee55ff66"}
  ]
}
\`\`\`

## Common Workflows

**Adding a task to today:**
\`\`\`
edit_doc(root="today", operations=[{"op": "insert", "under": "today", "items": [{"n": "Buy groceries", "l": "todo"}], "position": "top"}])
\`\`\`

**Reading and updating:**
1. read_doc(node_id="b605f0e85a4a", depth=2) — Get the subtree
2. edit_doc(root="b605f0e85a4a", operations=[...]) — Make changes using tags from the read

**Creating nested structures:**
\`\`\`json
{"op": "insert", "under": "inbox", "items": [
  {"n": "Project X", "l": "h2", "c": [
    {"n": "Task 1", "l": "todo"},
    {"n": "Task 2", "l": "todo"},
    {"n": "Notes", "c": [{"n": "Detail here"}]}
  ]}
], "position": "top"}
\`\`\`

## Node Types

| Type | Description |
|------|-------------|
| (none) | Regular bullet |
| \`todo\` | Checkbox/task |
| \`h1\` | Heading 1 |
| \`h2\` | Heading 2 |
| \`h3\` | Heading 3 |
| \`p\` | Paragraph |
| \`bullets\` | Bullet list item |
| \`code\` | Code block |
| \`quote\` | Quote block |
| \`table\` | Table (children are columns; each column's children are cells/rows) |


## Tables

A table is a node with \`"l": "table"\`. Its structure is:
- **Table node** (\`"l": "table"\`) → children are **columns**
- Each **column** → children are **cells** (rows are aligned by index across columns)
- All columns must have the same number of cell children (same row count). The API does not auto-normalize.

**Create a table:**
\`\`\`json
{"op": "insert", "under": "inbox", "items": [{
  "n": "Best Tacos", "l": "table", "c": [
    {"n": "Restaurant", "c": [{"n": "Taco Stand"}, {"n": "El Pastor"}]},
    {"n": "Rating", "c": [{"n": "9/10"}, {"n": "8/10"}]}
  ]
}], "position": "top"}
\`\`\`

**Edit table cells:** Use \`update\` with the cell's tag.
**Add a row:** Use one \`insert\` per column (with \`after\` the last cell tag in each column).
**Delete a row:** Use one \`delete\` per column for each cell in that row.
**Add a column:** \`insert\` under the table tag with one item whose \`c\` contains one cell per existing row.

## Bookmarks

Bookmarks store frequently-accessed node IDs with context notes:
- Call list_bookmarks at conversation start
- Use bookmark node_ids directly with read_doc
- Save new bookmarks for locations you'll need again

## Search

search_nodes searches the local cache by text. Use it when you don't know where something is. Results include the node ID which you can use with read_doc.

## Backups

- Daily backups store a full local export of the Workflowy account in the app data directory
- list_backups shows available snapshots and their file paths
- create_backup creates an extra snapshot on demand
- restore_backup restores the local cache from a stored snapshot; it does not upload content back into Workflowy
- export_backup copies a stored snapshot to another folder or file path

## Common Mistakes to Avoid

❌ **Skipping list_bookmarks** — The bookmark you need probably already exists.

❌ **Searching for dates** — Use \`today\`, \`tomorrow\`, \`next_week\` directly.

❌ **Multiple edit_doc calls** — Batch operations into one call when possible.

❌ **Editing without reading** — Update, delete, and move require a prior read to populate the cache.

❌ **Passing a full Workflowy URL to read_doc** — Extract the 12-hex ID after \`#/\` first.

## Tips
- Use \`depth: 2-3\` for most reads; increase only if needed
- The \`+: 1\` indicator means there's more content below the depth limit
- Calendar targets (today, tomorrow, etc.) auto-create if they don't exist
- If edit_doc returns a \`read_required\` error, run read_doc on the subtree and retry edit_doc
- Bookmarks persist across sessions — save important locations`;

// Tool descriptions - single source of truth for both MCP server and frontend
// These are the descriptions shown in the MCP protocol and in the UI
export const toolDescriptions = {
  list_bookmarks: `**START EVERY CONVERSATION BY CALLING THIS TOOL.** Returns saved Workflowy locations AND the user's custom AI instructions.

The response contains:
- bookmarks: Saved node locations with context notes (including node IDs — use these directly with read_doc!)
- user_instructions: The user's custom preferences (if they have an 'ai_instructions' bookmark)

**WHY THIS MATTERS:** Bookmarks contain node IDs. If the user asks about "the log" or "my inbox" and a bookmark exists, you already have the ID — no need to search.`,

  save_bookmark:
    "Save a Workflowy node with a name and context notes. The context field is for YOU (the LLM) to write notes about what this node contains and how to use it in future sessions.",

  delete_bookmark: "Delete a saved bookmark by name.",

  read_doc: `Read a Workflowy node and its children. Returns tag-as-key JSON.

**Node ID options:**
- A 12-hex tag (e.g., "b605f0e85a4a") or full UUID
- Special targets: "today", "tomorrow", "next_week", "inbox"
- "None" for the root/home level
- A Workflowy link (extract the 12-hex ID after \`#/\`)
- Calendar IDs: "YYYY", "YYYY-MM", "YYYY-MM-DD"

**Response format:**
- First key-value is the node's tag and name
- "d" is the node's note/description text (only present if the node has a note)
- "c" array contains children
- "l" is line type (todo, h1, h2, h3, p, bullets, code, quote, table)
- "x": 1 means completed
- Table nodes ("l": "table"): children are columns, each column's children are cells (rows aligned by index)
- "+": 1 means more children exist below depth limit
- Mirrors appear as \`{"<tag>": "Original Name", "m": "<original_short_id>", "c": [...]}\`: the "m" marker means this is a live mirror of another node, and the mirrored children are already included inline (no separate read needed)
- "ancestors" shows the path to root

**IMPORTANT:** After reading, you can use the tags in edit_doc operations.`,

  edit_doc: `Edit Workflowy nodes. Supports insert, update, delete, and move operations.

**Operations:**

INSERT — Create new nodes (use "under" OR "after", exactly one is required):
\`{"op": "insert", "under": "<tag>|today|inbox", "items": [{"n": "Name", "d": "Note text", "l": "todo"}], "position": "top|bottom"}\`
\`{"op": "insert", "after": "<sibling-tag>", "items": [{"n": "Name"}]}\`

UPDATE — Modify existing nodes (requires prior read_doc):
\`{"op": "update", "ref": "<tag>", "to": {"n": "New name", "d": "Updated note", "l": "h1", "x": 1}}\`

DELETE — Remove nodes (requires prior read_doc):
\`{"op": "delete", "ref": "<tag>"}\`

MOVE — Move a node with all children to a new parent (requires prior read_doc):
\`{"op": "move", "ref": "<tag>", "under": "<new-parent-tag>|inbox", "position": "top|bottom"}\`

**Parameters:**
- root: The subtree root tag (from a prior read_doc) OR a target like "today"
- operations: Array of operations to perform

**Item properties:**
- n: Name/text content (required for insert)
- d: Note/description text
- l: Line type (todo, h1, h2, h3, p, bullets, code, quote, table)
- x: Completion status (1 = complete, 0 = incomplete)
- c: Children array for nested structures

**Tables:**
Create a table with \`"l": "table"\`. Children are columns; each column's children are cells (rows aligned by index).
\`{"op": "insert", "under": "inbox", "items": [{"n": "My Table", "l": "table", "c": [{"n": "Col A", "c": [{"n": "Row 1"}, {"n": "Row 2"}]}, {"n": "Col B", "c": [{"n": "Val 1"}, {"n": "Val 2"}]}]}], "position": "top"}\`
Edit cells with update (ref = cell tag). Add rows with one insert per column (use "after" last cell). Delete rows with one delete per column.

**Behavior notes:**
- Update/delete/move should follow a prior read_doc of the same subtree
- If the API returns \`read_required\`, call read_doc for that root and retry
- Insert can target a known parent tag or a system target such as "today" or "inbox"
- Insert with "after" places items after a specific sibling (no position needed)

**Examples:**

Add task to today:
\`edit_doc(root="today", operations=[{"op": "insert", "under": "today", "items": [{"n": "Buy milk", "l": "todo"}], "position": "top"}])\`

Complete a task:
\`edit_doc(root="<root-tag>", operations=[{"op": "update", "ref": "<task-tag>", "to": {"x": 1}}])\`

Create nested structure:
\`edit_doc(root="inbox", operations=[{"op": "insert", "under": "inbox", "items": [{"n": "Project", "l": "h2", "c": [{"n": "Task 1", "l": "todo"}, {"n": "Task 2", "l": "todo"}]}], "position": "top"}])\`

Create a table:
\`edit_doc(root="inbox", operations=[{"op": "insert", "under": "inbox", "items": [{"n": "Scores", "l": "table", "c": [{"n": "Name", "c": [{"n": "Alice"}, {"n": "Bob"}]}, {"n": "Score", "c": [{"n": "95"}, {"n": "87"}]}]}], "position": "top"}])\``,

  search_nodes:
    "Search Workflowy nodes by text in the local cache. Returns matches with their path, child preview, and timestamps (created_at, modified_at, completed_at). Use the node_id from results with read_doc to get full content.",

  sync_nodes:
    "Sync all Workflowy nodes to local cache for searching. Rate limited to once per minute. The cache auto-syncs when stale (>1 hour).",

  list_backups:
    "List locally stored Workflowy account backups. Returns backup IDs, timestamps, file paths, sizes, and node counts.",

  create_backup:
    "Create a fresh full-account backup from Workflowy's nodes-export API and store it locally as a JSON snapshot. Rate limited to once per minute.",

  restore_backup:
    "Restore the local cache/search database from a stored backup snapshot. This does not upload data back into Workflowy; it only restores the local cached export.",

  export_backup:
    "Copy a stored backup snapshot to another file path or directory so the user can archive it elsewhere.",
} as const;

// Tool names in the order they should appear
export const toolNames = [
  "list_bookmarks",
  "save_bookmark",
  "delete_bookmark",
  "read_doc",
  "edit_doc",
  "search_nodes",
  "sync_nodes",
  "list_backups",
  "create_backup",
  "restore_backup",
  "export_backup",
] as const;

export type ToolName = (typeof toolNames)[number];

// Default tool definitions - for frontend display
export interface ToolDefinition {
  name: ToolName;
  defaultDescription: string;
}

export const defaultTools: ToolDefinition[] = toolNames.map((name) => ({
  name,
  defaultDescription: toolDescriptions[name],
}));
