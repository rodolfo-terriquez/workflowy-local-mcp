// Shared constants between the MCP server and the Tauri frontend
// This file is the single source of truth for default server instructions

export const defaultServerInstructions = `This MCP server connects to a user's Workflowy account. Workflowy is an outliner app where notes are organized as nested bullet points (nodes).

## Key Concepts
- Nodes have a UUID (id), name (text content), and optional note (description)
- Nodes can be nested infinitely under other nodes (parent_id)
- Special locations: 'inbox', 'home', or 'None' (top-level)

## Efficiency Guidelines (READ FIRST)

**1. Fetch siblings together, not separately**
When you need content from multiple nodes at the same level (e.g., several entries, items, or sections), don't fetch each one individually. Instead:
1. Search for ONE of them
2. Use its parent_id with get_node_tree
3. Set depth high enough to include the content you need
This gets ALL siblings in a single call instead of N separate calls.

**2. Bookmarks first**
Always call list_bookmarks when the user mentions a named location (e.g., "my inbox", "the log", "project notes"). Bookmarks are the user's saved shortcuts — faster and more reliable than searching.

**3. Special parent_id shortcuts**
create_node and move_node accept these special values directly — no lookup needed:
- "inbox" — User's inbox
- "home" — Home/root level
- "None" — Top-level of account

**4. Use children_preview from search results**
search_nodes returns a preview of each result's children (first 5 + total count). This often provides enough context to identify the right node without needing a follow-up get_node_tree call.

**When to stop:** If children_preview shows the content needed (e.g., session titles, task names), present that to the user — don't fetch additional detail unless they ask for it.

**5. Progressive depth strategy**
Start with depth 2-3 for get_node_tree. Results show "(N children)" hints. If you need deeper content, do a targeted get_node_tree on a specific subtree rather than increasing depth on the root.

**6. Leverage parent_id from responses**
Every search result includes parent_id and path. Use parent_id with get_node_tree to explore siblings without re-searching.

## Start with Bookmarks
**Always check bookmarks first** when the user asks about specific content. Bookmarks contain context notes that tell you what each location contains and how to use it.

1. Call list_bookmarks to see all saved locations with their context
2. If a relevant bookmark exists, use get_node_tree with that node_id
3. If no bookmark matches, use search_nodes to find the content

## Displaying Node Trees
get_node_tree returns pre-formatted markdown. Display this output directly to the user WITHOUT modifications:
- Do NOT summarize or paraphrase
- Do NOT convert to tables
- Do NOT remove the ▾ symbols (they indicate nested content)
- Just show the markdown as-is

## Search with Child Previews
search_nodes returns matches with a **preview of their children** (first 5 children + total count). This lets you evaluate which result is relevant in ONE call:

- children_count: How many items are inside this node
- children_preview: First 5 children with their names and child counts
- Use this to identify the right result without needing additional reads

## Saving Bookmarks with Context
When you find an important location, save it with context notes for future sessions:

\`\`\`
save_bookmark(
  name: "daily_tasks",
  node_id: "abc-123",
  context: "User's daily todo list. Items use [ ] for incomplete, [x] for complete. Check here first when user asks about tasks."
)
\`\`\`

The context field is for YOU to write notes about:
- What the node contains
- How items are formatted
- When to use this bookmark

## Common Workflows

**Answering "What are my tasks?"**
1. list_bookmarks → Check if a tasks bookmark exists with context
2. If yes: get_node_tree with that node_id → Present output as-is
3. If no: search_nodes("tasks") → Use children_preview to pick the right result → Save bookmark for next time

**Creating new content (IMPORTANT - use multiline markdown):**
1. list_bookmarks to find the right parent location
2. Use ONE create_node call with multiline markdown to create entire structures:

\`\`\`
create_node(
  parent_id: "node-uuid",
  name: "## Section Title

- First item

- Second item

## Another Section

- More items"
)
\`\`\`

This creates multiple nodes in ONE API call:
- Separate siblings with blank lines (actual newlines in the name field)
- Use ## for headers, - for bullets, - [ ] for todos
- IMPORTANT: Do NOT use the literal string \\n\\n — use actual line breaks
- NEVER make multiple create_node calls when you can use multiline markdown instead

**Marking tasks complete:**
- update_node with completed=true

## Calendar & Date Nodes
Workflowy has a calendar system that auto-creates date nodes (e.g., "Jan 15, 2025", "Today - Jan 15", "Tomorrow - Jan 16"). These date nodes may have prefixes like "Today", "Yesterday", "Tomorrow" depending on user preferences.

**CRITICAL: Always search before creating date-related content.**
- Before adding items to a date, ALWAYS search for that date first
- Date nodes may appear with different text (e.g., "Today - Jan 15" vs "Jan 15, 2025") - they are the SAME node
- If a date node exists, use update_node or create_node with that node as parent - NEVER create a duplicate date
- When searching for dates, try multiple formats: "Jan 15", "January 15", "2025-01-15", "Today"

## AI Instructions (Custom User Preferences)
Users can create a node in Workflowy called "AI Instructions" to customize your behavior. If you find such a node:

1. **First session**: Search for "AI Instructions" node
2. **If found**: Save it as a bookmark named "ai_instructions" (this exact name is reserved)
3. **Future sessions**: The instructions will automatically load and appear at the end of these instructions

The AI Instructions node can contain preferences like:
- "Always add new tasks to my #inbox"
- "Use checkboxes [ ] for tasks, not bullets"
- "My calendar is under 'Daily Notes > 2025'"
- "Prefer concise responses"

If the user asks you to update their AI instructions, find the node and use update_node or create child nodes as needed.

## Tips
- **ALWAYS UPDATE, NEVER DUPLICATE**: When adding to existing structures (dates, projects, lists), search first and add to the existing node rather than creating a new one
- **EFFICIENCY**: Use multiline markdown in create_node to add multiple items in one call
- get_node_tree returns compact text format - show it to the user without modification
- Search results include children_preview so you can evaluate relevance in one call
- Save bookmarks with detailed context to speed up future sessions
- The cache auto-syncs when stale (>1 hour) but you can force sync with sync_nodes`;

// Tool descriptions - single source of truth for both MCP server and frontend
// These are the descriptions shown in the MCP protocol and in the UI
export const toolDescriptions = {
  list_bookmarks: `**START EVERY CONVERSATION BY CALLING THIS TOOL.** This returns saved Workflowy locations AND the user's custom AI instructions.

The response contains:
- bookmarks: Saved node locations with context notes
- user_instructions: The user's custom preferences (if they have an 'ai_instructions' bookmark)

IMPORTANT: If user_instructions exists in the response, follow those preferences for the entire conversation. These are the user's personal instructions for how you should interact with their Workflowy.`,

  save_bookmark:
    "Save a Workflowy node with a name and context notes. The context field is for YOU (the LLM) to write notes about what this node contains and how to use it in future sessions. Check similar bookmarks before creating a new one to avoid duplicates.",

  delete_bookmark: "Delete a saved bookmark by name.",

  get_node_tree:
    "Get a node and its nested children. Returns markdown with items showing '(N children)' when they have nested content. Show this to the user so they know which items can be expanded further.\n\n**IMPORTANT:** If the user's task involves moving, updating, or deleting items, use `format: 'json'` to get node IDs in one call. Don't fetch compact first then search for IDs separately.",

  create_node: `Create a new node in Workflowy. SUPPORTS MARKDOWN for creating multiple nested nodes in ONE call.

**MULTILINE NODES**: Separate siblings with blank lines (actual newlines). First line = parent, subsequent lines = children.
**MARKDOWN HEADERS**: # h1, ## h2, ### h3 create header nodes
**BULLETS**: - item creates bullet points
**TODOS**: - [ ] task creates unchecked todo, - [x] task creates checked todo
**FORMATTING**: **bold**, *italic*, \`code\`, [link](url)

EXAMPLE - Create a full structure in ONE call:
name:
"## Topics Discussed

- First topic

- Second topic

## Decisions

- Decision one

- Decision two"

This creates:
  Topics Discussed (h2)
    First topic
    Second topic
  Decisions (h2)
    Decision one
    Decision two

IMPORTANT: Use actual line breaks to separate items. Do NOT use the literal string \\n\\n — it will be stored as text, not parsed as newlines.

PREFER multiline markdown over multiple create_node calls for efficiency.`,

  update_node:
    "Update an existing node's name, note, or completed status. Use this to edit content or mark tasks complete/incomplete.",

  delete_node:
    "Permanently delete a node and all its children. Use with caution.",

  move_node: "Move a node to a different parent location.",

  search_nodes:
    "Search Workflowy nodes by text. Returns matches with their path AND a preview of their children (first 5 children with their child counts). Use the children_preview to evaluate which result is most relevant without needing additional reads.",

  sync_nodes:
    "Sync all Workflowy nodes to local cache for searching. Rate limited to once per minute. Use this before searching if cache is empty or stale.",
} as const;

// Tool names in the order they should appear
export const toolNames = [
  "list_bookmarks",
  "save_bookmark", 
  "delete_bookmark",
  "get_node_tree",
  "create_node",
  "update_node",
  "delete_node",
  "move_node",
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
