// Shared constants between the MCP server and the Tauri frontend
// This file is the single source of truth for default server instructions

export const defaultServerInstructions = `This MCP server connects to a user's Workflowy account. Workflowy is an outliner app where notes are organized as nested bullet points (nodes).

## STOP — Read This First

**Before making ANY tool call, follow this checklist:**

1. **Call list_bookmarks FIRST** — It returns saved locations (including the node IDs you need) AND the user's custom instructions. Skip this = wasted calls.

2. **One read, one edit** — Use read_doc to fetch a subtree, then edit_doc to make changes. You can batch multiple operations (insert, update, delete) in a single edit_doc call.

3. **Calendar shortcuts** — Use \`today\`, \`tomorrow\`, \`next_week\`, or \`inbox\` as node_id values. No need to search for date nodes.

## Key Concepts
- Nodes are identified by 12-character hex tags (e.g., "b605f0e85a4a")
- Nodes can have: name (text), type (h1/h2/h3/todo/bullets/code/quote), completion status (x: 1 or 0)
- Children are nested in the "c" array
- Special targets: \`today\`, \`tomorrow\`, \`next_week\`, \`inbox\`, \`None\` (home/root)

## read_doc Response Format

The API returns tag-as-key JSON. Example:
\`\`\`json
{
  "b605f0e85a4a": "My Project",
  "c": [
    {"aa11bb22cc33": "Task 1", "l": "todo", "x": 1},
    {"dd44ee55ff66": "Task 2", "l": "todo"},
    {"7788990011ab": "Notes", "c": [...], "+": 1}
  ],
  "ancestors": [{"None": "Home"}]
}
\`\`\`

- The first key-value is the node's tag and name
- \`c\` contains children
- \`l\` is the line type (todo, h1, h2, h3, bullets, code, quote)
- \`x: 1\` means completed
- \`+: 1\` means there are more children below the depth limit

## edit_doc Operations

**Insert** — Create new nodes:
\`\`\`json
{"op": "insert", "under": "today", "items": [{"n": "New task", "l": "todo"}], "position": "top"}
\`\`\`

**Update** — Modify existing nodes (requires prior read):
\`\`\`json
{"op": "update", "ref": "aa11bb22cc33", "to": {"n": "Renamed", "x": 1}}
\`\`\`

**Delete** — Remove nodes (requires prior read):
\`\`\`json
{"op": "delete", "ref": "aa11bb22cc33"}
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
| \`bullets\` | Bullet list item |
| \`code\` | Code block |
| \`quote\` | Quote block |

## Bookmarks

Bookmarks store frequently-accessed node IDs with context notes:
- Call list_bookmarks at conversation start
- Use bookmark node_ids directly with read_doc
- Save new bookmarks for locations you'll need again

## Search

search_nodes searches the local cache by text. Use it when you don't know where something is. Results include the node ID which you can use with read_doc.

## Common Mistakes to Avoid

❌ **Skipping list_bookmarks** — The bookmark you need probably already exists.

❌ **Searching for dates** — Use \`today\`, \`tomorrow\`, \`next_week\` directly.

❌ **Multiple edit_doc calls** — Batch operations into one call when possible.

❌ **Editing without reading** — Update and delete require a prior read to populate the cache.

## Tips
- Use \`depth: 2-3\` for most reads; increase only if needed
- The \`+: 1\` indicator means there's more content below the depth limit
- Calendar targets (today, tomorrow, etc.) auto-create if they don't exist
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

**Response format:**
- First key-value is the node's tag and name
- "c" array contains children
- "l" is line type (todo, h1, h2, h3, bullets, code, quote)
- "x": 1 means completed
- "+": 1 means more children exist below depth limit
- "ancestors" shows the path to root

**IMPORTANT:** After reading, you can use the tags in edit_doc operations.`,

  edit_doc: `Edit Workflowy nodes. Supports insert, update, and delete operations.

**Operations:**

INSERT — Create new nodes:
\`{"op": "insert", "under": "<tag>|today|inbox", "items": [{"n": "Name", "l": "todo"}], "position": "top|bottom"}\`

UPDATE — Modify existing nodes (requires prior read_doc):
\`{"op": "update", "ref": "<tag>", "to": {"n": "New name", "l": "h1", "x": 1}}\`

DELETE — Remove nodes (requires prior read_doc):
\`{"op": "delete", "ref": "<tag>"}\`

**Parameters:**
- root: The subtree root tag (from a prior read_doc) OR a target like "today"
- operations: Array of operations to perform

**Item properties:**
- n: Name/text content (required for insert)
- l: Line type (todo, h1, h2, h3, bullets, code, quote)
- x: Completion status (1 = complete, 0 = incomplete)
- c: Children array for nested structures

**Examples:**

Add task to today:
\`edit_doc(root="today", operations=[{"op": "insert", "under": "today", "items": [{"n": "Buy milk", "l": "todo"}], "position": "top"}])\`

Complete a task:
\`edit_doc(root="<root-tag>", operations=[{"op": "update", "ref": "<task-tag>", "to": {"x": 1}}])\`

Create nested structure:
\`edit_doc(root="inbox", operations=[{"op": "insert", "under": "inbox", "items": [{"n": "Project", "l": "h2", "c": [{"n": "Task 1", "l": "todo"}, {"n": "Task 2", "l": "todo"}]}], "position": "top"}])\``,

  search_nodes:
    "Search Workflowy nodes by text in the local cache. Returns matches with their path and a preview of children. Use the node_id from results with read_doc to get full content.",

  sync_nodes:
    "Sync all Workflowy nodes to local cache for searching. Rate limited to once per minute. The cache auto-syncs when stale (>1 hour).",
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
