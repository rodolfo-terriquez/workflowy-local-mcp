import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Use the asm.js version to avoid needing WASM file at runtime
import initSqlJs from "sql.js/dist/sql-asm.js";
import type { Database } from "sql.js";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

// Config interface
interface Config {
  apiKey?: string;
  serverDescription?: string;
  toolDescriptions?: Record<string, string>;
}

// Get data directory - use app data folder
// Must match the Tauri app identifier in tauri.conf.json
function getDataDir(): string {
  const appName = "com.workflowy.local-mcp";
  const home = os.homedir();

  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", appName);
  } else if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(home, "AppData", "Roaming"),
      appName,
    );
  } else {
    return path.join(home, ".local", "share", appName);
  }
}

// Load config from file
function loadConfig(): Config {
  const dataDir = getDataDir();
  const configPath = path.join(dataDir, "config.json");

  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      // Ignore parse errors
    }
  }
  return {};
}

// Database singleton
let dbInstance: Database | null = null;
let SQL: initSqlJs.SqlJsStatic | null = null;

// Initialize SQLite database
async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = path.join(dataDir, "bookmarks.db");

  // Initialize sql.js
  if (!SQL) {
    SQL = await initSqlJs();
  }

  // Load existing database or create new one
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    dbInstance = new SQL.Database(fileBuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  // Create table if it doesn't exist (with context field for LLM notes)
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      name TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      context TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add context column to existing bookmarks table if it doesn't exist
  // This handles databases created before the context column was added
  const bookmarksTableInfo = dbInstance.exec("PRAGMA table_info(bookmarks)");
  if (bookmarksTableInfo.length > 0) {
    const columns = bookmarksTableInfo[0].values.map((row) => row[1]); // column name is at index 1
    if (!columns.includes("context")) {
      dbInstance.run("ALTER TABLE bookmarks ADD COLUMN context TEXT");
    }
  }

  // Create nodes cache table (with children_count and priority for ordering)
  dbInstance.run(`
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
  `);

  // Migration: Add missing columns to existing nodes table
  const nodesTableInfo = dbInstance.exec("PRAGMA table_info(nodes)");
  if (nodesTableInfo.length > 0) {
    const columns = nodesTableInfo[0].values.map((row) => row[1]); // column name is at index 1
    if (!columns.includes("children_count")) {
      dbInstance.run("ALTER TABLE nodes ADD COLUMN children_count INTEGER DEFAULT 0");
    }
    if (!columns.includes("priority")) {
      dbInstance.run("ALTER TABLE nodes ADD COLUMN priority INTEGER DEFAULT 0");
    }
    if (!columns.includes("created_at")) {
      dbInstance.run("ALTER TABLE nodes ADD COLUMN created_at TEXT");
    }
    if (!columns.includes("updated_at")) {
      dbInstance.run("ALTER TABLE nodes ADD COLUMN updated_at TEXT");
    }
  }

  // Create indexes for efficient querying
  // Note: sql.js doesn't support FTS5, so we use LIKE with indexes
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`,
  );
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_completed ON nodes(completed)`,
  );
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_priority ON nodes(parent_id, priority)`,
  );
  // Index for text search (helps with LIKE queries on large datasets)
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)`,
  );
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_note ON nodes(note)`,
  );

  // Create sync metadata table
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Save after creating table
  saveDb();

  return dbInstance;
}

// Save database to disk
function saveDb(): void {
  if (!dbInstance) return;

  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, "bookmarks.db");
  const data = dbInstance.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Rate limiting for nodes-export endpoint (1 request per minute)
let lastExportRequestTime: number = 0;
const EXPORT_RATE_LIMIT_MS = 60000; // 1 minute

// Stale threshold for cache (1 hour)
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function canCallExport(): { allowed: boolean; waitMs: number } {
  const now = Date.now();
  const elapsed = now - lastExportRequestTime;
  if (elapsed >= EXPORT_RATE_LIMIT_MS) {
    return { allowed: true, waitMs: 0 };
  }
  return { allowed: false, waitMs: EXPORT_RATE_LIMIT_MS - elapsed };
}

function markExportCalled(): void {
  lastExportRequestTime = Date.now();
}

// Build breadcrumb path for a node by walking up parent_id chain
function buildNodePath(db: Database, nodeId: string): string[] {
  const path: string[] = [];
  let currentId: string | null = nodeId;
  const visited = new Set<string>(); // Prevent infinite loops

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);

    const result = db.exec("SELECT name, parent_id FROM nodes WHERE id = ?", [
      currentId,
    ]);

    if (result.length === 0 || result[0].values.length === 0) {
      break;
    }

    const [name, parentId] = result[0].values[0];
    path.unshift(name as string); // Add to front
    currentId = parentId as string | null;
  }

  return path;
}

// Format path as display string
function formatPathString(path: string[]): string {
  if (path.length === 0) return "(root)";
  if (path.length === 1) return path[0];

  // Truncate long paths: "Grandparent > ... > Parent > Node"
  if (path.length > 4) {
    return `${path[0]} > ... > ${path[path.length - 2]} > ${path[path.length - 1]}`;
  }

  return path.join(" > ");
}

// Delete a node and all its descendants recursively
function deleteNodeAndDescendants(db: Database, nodeId: string): void {
  // Get all children
  const children = db.exec("SELECT id FROM nodes WHERE parent_id = ?", [
    nodeId,
  ]);
  if (children.length > 0 && children[0].values.length > 0) {
    children[0].values.forEach((row) => {
      deleteNodeAndDescendants(db, row[0] as string);
    });
  }
  // Delete the node itself
  db.run("DELETE FROM nodes WHERE id = ?", [nodeId]);
}

// Update node cache after write operations
function updateNodeCache(
  db: Database,
  operation: "insert" | "update" | "delete",
  nodeData: {
    id: string;
    name?: string;
    note?: string;
    parent_id?: string | null;
    completed?: boolean;
  },
): void {
  switch (operation) {
    case "insert":
      db.run(
        "INSERT OR REPLACE INTO nodes (id, name, note, parent_id, completed) VALUES (?, ?, ?, ?, ?)",
        [
          nodeData.id,
          nodeData.name || "",
          nodeData.note || "",
          nodeData.parent_id || null,
          nodeData.completed ? 1 : 0,
        ],
      );
      break;
    case "update": {
      const updates: string[] = [];
      const params: (string | number | null)[] = [];
      if (nodeData.name !== undefined) {
        updates.push("name = ?");
        params.push(nodeData.name);
      }
      if (nodeData.note !== undefined) {
        updates.push("note = ?");
        params.push(nodeData.note);
      }
      if (nodeData.parent_id !== undefined) {
        updates.push("parent_id = ?");
        params.push(nodeData.parent_id);
      }
      if (nodeData.completed !== undefined) {
        updates.push("completed = ?");
        params.push(nodeData.completed ? 1 : 0);
      }
      if (updates.length > 0) {
        params.push(nodeData.id);
        db.run(`UPDATE nodes SET ${updates.join(", ")} WHERE id = ?`, params);
      }
      break;
    }
    case "delete":
      deleteNodeAndDescendants(db, nodeData.id);
      break;
  }
  saveDb();
}

// Perform full sync of all nodes from Workflowy API
async function performFullSync(
  apiKey: string,
  db: Database,
): Promise<{
  success: boolean;
  nodes_synced?: number;
  synced_at?: string;
  error?: string;
}> {
  // Check rate limit
  const { allowed, waitMs } = canCallExport();
  if (!allowed) {
    return {
      success: false,
      error: `Rate limited. Please wait ${Math.ceil(waitMs / 1000)} seconds.`,
    };
  }

  // Check if sync already in progress
  const inProgressResult = db.exec(
    "SELECT value FROM sync_meta WHERE key = 'sync_in_progress'",
  );
  if (
    inProgressResult.length > 0 &&
    inProgressResult[0].values[0][0] === "true"
  ) {
    return {
      success: false,
      error: "Sync already in progress.",
    };
  }

  // Mark sync in progress
  db.run(
    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_in_progress', 'true')",
  );
  saveDb();

  try {
    markExportCalled();

    const url = "https://workflowy.com/api/v1/nodes-export";
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const responseData = (await res.json()) as {
      nodes: Array<{
        id: string;
        name?: string;
        note?: string;
        parent_id?: string;
        completed?: boolean;
        priority?: number;
        createdAt?: number;
        modifiedAt?: number;
      }>;
    };

    const nodes = responseData.nodes || [];

    // Build a map to count children for each node
    const childrenCountMap = new Map<string, number>();
    for (const node of nodes) {
      if (node.parent_id) {
        childrenCountMap.set(
          node.parent_id,
          (childrenCountMap.get(node.parent_id) || 0) + 1,
        );
      }
    }

    // Transactional update
    db.run("BEGIN TRANSACTION");
    db.run("DELETE FROM nodes");

    for (const node of nodes) {
      const childrenCount = childrenCountMap.get(node.id) || 0;
      db.run(
        "INSERT INTO nodes (id, name, note, parent_id, completed, children_count, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          node.id,
          node.name || "",
          node.note || "",
          node.parent_id || null,
          node.completed ? 1 : 0,
          childrenCount,
          node.priority || 0,
          node.createdAt ? new Date(node.createdAt * 1000).toISOString() : null,
          node.modifiedAt
            ? new Date(node.modifiedAt * 1000).toISOString()
            : null,
        ],
      );
    }

    // Update metadata
    const now = new Date().toISOString();
    db.run(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_full_sync', ?)",
      [now],
    );
    db.run(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('last_sync_node_count', ?)",
      [String(nodes.length)],
    );
    db.run(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_in_progress', 'false')",
    );

    db.run("COMMIT");
    saveDb();

    return {
      success: true,
      nodes_synced: nodes.length,
      synced_at: now,
    };
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    db.run(
      "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_in_progress', 'false')",
    );
    saveDb();

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Ensure cache is fresh before read operations (auto-sync if needed)
async function ensureCacheFresh(
  apiKey: string,
  db: Database,
): Promise<{ synced: boolean; error?: string }> {
  // Check node count
  const countResult = db.exec("SELECT COUNT(*) FROM nodes");
  const nodeCount = (countResult[0]?.values[0][0] as number) ?? 0;

  // Check last sync time
  const metaResult = db.exec(
    "SELECT value FROM sync_meta WHERE key = 'last_full_sync'",
  );
  const lastSync = metaResult[0]?.values[0]?.[0] as string | undefined;

  // Determine if sync needed
  let needsSync = nodeCount === 0; // Empty cache
  if (!needsSync && lastSync) {
    const lastSyncDate = new Date(lastSync);
    const msOld = Date.now() - lastSyncDate.getTime();
    needsSync = msOld > STALE_THRESHOLD_MS;
  } else if (!lastSync) {
    needsSync = true;
  }

  if (!needsSync) {
    return { synced: false };
  }

  // Check rate limit
  const { allowed } = canCallExport();
  if (!allowed) {
    return { synced: false, error: "Rate limited - using existing cache" };
  }

  // Perform sync
  const result = await performFullSync(apiKey, db);
  if (result.success) {
    return { synced: true };
  }
  return { synced: false, error: result.error };
}

// Build a node tree with nested children up to specified depth
interface NodeTree {
  id: string;
  name: string;
  note: string | null;
  parent_id: string | null;
  completed: boolean;
  children_count: number;
  children?: NodeTree[];
}

function buildNodeTree(
  db: Database,
  nodeId: string | null,
  depth: number,
  currentDepth: number = 0,
  excludeNodeNames: string[] = [],
): NodeTree[] {
  if (currentDepth >= depth) {
    return [];
  }

  // Query children of this node (ordered by priority, then name)
  const parentCondition =
    nodeId === null ? "parent_id IS NULL" : "parent_id = ?";
  const params = nodeId === null ? [] : [nodeId];

  const results = db.exec(
    `SELECT id, name, note, parent_id, completed, children_count FROM nodes WHERE ${parentCondition} ORDER BY priority, name`,
    params,
  );

  if (results.length === 0 || results[0].values.length === 0) {
    return [];
  }

  return results[0].values
    .filter((row) => {
      const name = row[1] as string;
      // Filter out excluded node names
      return !excludeNodeNames.includes(name);
    })
    .map((row) => {
      const node: NodeTree = {
        id: row[0] as string,
        name: row[1] as string,
        note: (row[2] as string) || null,
        parent_id: (row[3] as string) || null,
        completed: row[4] === 1,
        children_count: (row[5] as number) || 0,
      };

      // Recursively get children if we haven't reached max depth
      if (currentDepth + 1 < depth) {
        const children = buildNodeTree(db, node.id, depth, currentDepth + 1, excludeNodeNames);
        if (children.length > 0) {
          node.children = children;
        }
      }

      return node;
    });
}

// Format node tree as markdown (for display to user)
function formatNodeTreeMarkdown(
  nodes: NodeTree[],
  indentLevel: number = 0,
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(indentLevel);

  for (const node of nodes) {
    // Markdown list format: "- Item" or "- Item (N children)" if it has children
    let line = `${indent}- ${node.name}`;

    // Add children count if node has children (helps LLM and user understand nesting)
    if (node.children_count > 0) {
      line += ` (${node.children_count} children)`;
    }

    // Add note if present
    if (node.note && node.note.trim()) {
      line += ` — ${node.note.trim()}`;
    }

    lines.push(line);

    // Recursively format children if they were fetched
    if (node.children && node.children.length > 0) {
      const childrenText = formatNodeTreeMarkdown(node.children, indentLevel + 1);
      lines.push(childrenText);
    }
  }

  return lines.join("\n");
}

// Get a single node by ID from local cache
function getNodeFromCache(db: Database, nodeId: string): NodeTree | null {
  const results = db.exec(
    "SELECT id, name, note, parent_id, completed, children_count FROM nodes WHERE id = ?",
    [nodeId],
  );

  if (results.length === 0 || results[0].values.length === 0) {
    return null;
  }

  const row = results[0].values[0];
  return {
    id: row[0] as string,
    name: row[1] as string,
    note: (row[2] as string) || null,
    parent_id: (row[3] as string) || null,
    completed: row[4] === 1,
    children_count: (row[5] as number) || 0,
  };
}

// Get API key from environment or config file
function getApiKey(): string {
  // First check environment variable
  if (process.env.WORKFLOWY_API_KEY) {
    return process.env.WORKFLOWY_API_KEY;
  }

  // Then check config file
  const config = loadConfig();
  if (config.apiKey) {
    return config.apiKey;
  }

  throw new Error(
    "Workflowy API key not configured. Please set it in the app settings.",
  );
}

// Helper function for Workflowy API requests
async function workflowyRequest(
  apiKey: string,
  urlPath: string,
  method: "GET" | "POST" | "DELETE",
  body?: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = `https://workflowy.com${urlPath}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          { http_status: res.status, ok: res.ok, data },
          null,
          2,
        ),
      },
    ],
  };
}

// Validate Workflowy token
async function validateWorkflowyToken(apiKey: string): Promise<void> {
  const res = await fetch("https://workflowy.com/api/v1/targets", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error("Invalid Workflowy API key");
  }
}

// Default tool definitions
const defaultTools = [
  // Bookmark tools
  {
    name: "save_bookmark",
    description:
      "Save a Workflowy node with a name and context notes. The context field is for YOU (the LLM) to write notes about what this node contains and how to use it in future sessions. Check similar bookmarks before creating a new one to avoid duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "A friendly name for the bookmark (e.g., 'daily_tasks', 'project_notes')",
        },
        node_id: {
          type: "string",
          description: "The Workflowy node UUID to bookmark",
        },
        context: {
          type: "string",
          description:
            "Notes for your future self about this bookmark. Describe what the node contains, how items are formatted, and when to use it. Example: 'User\\'s daily todo list. Items use [ ] for incomplete, [x] for complete. Check here first when user asks about tasks.'",
        },
      },
      required: ["name", "node_id"],
    },
  },
  {
    name: "list_bookmarks",
    description:
      "List all saved bookmarks with their context notes. Start here to see what locations you've already discovered and saved. The context field contains notes about what each bookmark contains.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_bookmark",
    description: "Delete a saved bookmark by name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The bookmark name to delete" },
      },
      required: ["name"],
    },
  },
  // Workflowy read tools
  {
    name: "get_node_tree",
    description:
      "Get a node and its nested children. Returns markdown with items showing '(N children)' when they have nested content. Show this to the user so they know which items can be expanded further.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description:
            "The node UUID to retrieve, or 'None' for top-level nodes",
        },
        depth: {
          type: "number",
          description:
            "How many levels of children to include (default: 2, max: 10)",
        },
        format: {
          type: "string",
          description:
            "Output format: 'compact' (human-readable text, default) or 'json' (structured data)",
        },
      },
      required: ["node_id"],
    },
  },
  // Workflowy write tools
  {
    name: "create_node",
    description: `Create a new node in Workflowy. SUPPORTS MARKDOWN for creating multiple nested nodes in ONE call.

**MULTILINE NODES**: Use \\n\\n (double newline) to create siblings. First line = parent, subsequent lines = children.
**MARKDOWN HEADERS**: # h1, ## h2, ### h3 create header nodes
**BULLETS**: - item creates bullet points
**TODOS**: - [ ] task creates unchecked todo, - [x] task creates checked todo
**FORMATTING**: **bold**, *italic*, \`code\`, [link](url)

EXAMPLE - Create a full structure in ONE call:
name: "## Topics Discussed\\n\\n- First topic\\n\\n- Second topic\\n\\n## Decisions\\n\\n- Decision one\\n\\n- Decision two"

This creates:
  Topics Discussed (h2)
    First topic
    Second topic
  Decisions (h2)
    Decision one
    Decision two

PREFER multiline markdown over multiple create_node calls for efficiency.`,
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The text content. Use \\n\\n for siblings, markdown for structure (# h1, ## h2, - bullet, - [ ] todo, **bold**)",
        },
        parent_id: {
          type: "string",
          description:
            "Where to create the node: 'inbox', 'home', 'None' for top-level, or a node UUID",
        },
        note: {
          type: "string",
          description: "Optional note/description for the node",
        },
        position: {
          type: "string",
          enum: ["top", "bottom"],
          description: "Where to place the node: 'top' (default) or 'bottom'",
        },
      },
      required: ["name", "parent_id"],
    },
  },
  {
    name: "update_node",
    description:
      "Update an existing node's name, note, or completed status. Use this to edit content or mark tasks complete/incomplete.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node UUID to update" },
        name: { type: "string", description: "New name/text for the node" },
        note: { type: "string", description: "New note for the node" },
        completed: {
          type: "boolean",
          description:
            "Set completed status: true to mark complete (checked), false to mark incomplete (unchecked)",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "delete_node",
    description:
      "Permanently delete a node and all its children. Use with caution.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node UUID to delete" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "move_node",
    description: "Move a node to a different parent location.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node UUID to move" },
        parent_id: {
          type: "string",
          description:
            "New parent: 'inbox', 'home', 'None' for top-level, or a node UUID",
        },
      },
      required: ["node_id", "parent_id"],
    },
  },
  // Cache and search tools
  {
    name: "search_nodes",
    description:
      "Search Workflowy nodes by text. Returns matches with their path AND a preview of their children (first 5 children with their child counts). Use the children_preview to evaluate which result is most relevant without needing additional reads.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search text (searches name and note fields)",
        },
        include_completed: {
          type: "boolean",
          description: "Include completed nodes in results (default: false)",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 20, max: 100)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sync_nodes",
    description:
      "Sync all Workflowy nodes to local cache for searching. Rate limited to once per minute. Use this before searching if cache is empty or stale.",
    inputSchema: {
      type: "object",
      properties: {
        force: {
          type: "boolean",
          description:
            "Force sync even if recently synced (still respects API rate limit)",
        },
      },
    },
  },
];

// Get tools with custom descriptions merged in
function getTools() {
  const config = loadConfig();
  const customDescriptions = config.toolDescriptions || {};

  return defaultTools.map((tool) => ({
    ...tool,
    description: customDescriptions[tool.name] || tool.description,
  }));
}

// Default server instructions
const defaultServerInstructions = `This MCP server connects to a user's Workflowy account. Workflowy is an outliner app where notes are organized as nested bullet points (nodes).

## Key Concepts
- Nodes have a UUID (id), name (text content), and optional note (description)
- Nodes can be nested infinitely under other nodes (parent_id)
- Special locations: 'inbox', 'home', or 'None' (top-level)

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
  name: "## Section Title\\n\\n- First item\\n\\n- Second item\\n\\n## Another Section\\n\\n- More items"
)
\`\`\`

This creates multiple nodes in ONE API call:
- Use \\n\\n (double newline) between siblings
- Use ## for headers, - for bullets, - [ ] for todos
- NEVER make multiple create_node calls when you can use multiline markdown instead

**Marking tasks complete:**
- update_node with completed=true

## Tips
- **EFFICIENCY**: Use multiline markdown in create_node to add multiple items in one call
- get_node_tree returns compact text format - show it to the user without modification
- Search results include children_preview so you can evaluate relevance in one call
- Save bookmarks with detailed context to speed up future sessions
- The cache auto-syncs when stale (>1 hour) but you can force sync with sync_nodes`;

// Get server instructions dynamically
function getServerInstructions(): string {
  const config = loadConfig();
  return config.serverDescription || defaultServerInstructions;
}

// Main server setup
async function main() {
  const server = new Server(
    {
      name: "workflowy-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
    },
  );

  // List tools handler - reload config each time to pick up changes
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getTools(),
  }));

  // List prompts handler - exposes server instructions as a prompt
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "server_instructions",
        description:
          "Get the current server instructions and context for working with Workflowy",
      },
    ],
  }));

  // Get prompt handler - returns dynamic server instructions
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === "server_instructions") {
      return {
        description: "Server instructions for working with Workflowy",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: getServerInstructions(),
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const db = await getDb();
    const apiKey = getApiKey();

    await validateWorkflowyToken(apiKey);

    switch (name) {
      // Bookmark operations
      case "save_bookmark": {
        const name = args.name as string;
        const nodeId = args.node_id as string;
        const context = (args.context as string) || null;

        // Delete existing bookmark with same name if exists
        db.run("DELETE FROM bookmarks WHERE name = ?", [name]);
        db.run(
          "INSERT INTO bookmarks (name, node_id, context) VALUES (?, ?, ?)",
          [name, nodeId, context],
        );
        saveDb();
        return {
          content: [
            {
              type: "text",
              text: `Bookmark "${name}" saved with node ID: ${nodeId}${context ? ` and context: "${context}"` : ""}`,
            },
          ],
        };
      }

      case "list_bookmarks": {
        const results = db.exec(
          "SELECT name, node_id, context, created_at FROM bookmarks ORDER BY name",
        );
        const rows =
          results.length > 0
            ? results[0].values.map((row) => ({
                name: row[0],
                node_id: row[1],
                context: row[2] || null,
                created_at: row[3],
              }))
            : [];
        return {
          content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        };
      }

      case "delete_bookmark": {
        const before = db.exec(
          "SELECT COUNT(*) FROM bookmarks WHERE name = ?",
          [args.name],
        );
        const count =
          before.length > 0 ? (before[0].values[0][0] as number) : 0;
        db.run("DELETE FROM bookmarks WHERE name = ?", [args.name]);
        saveDb();
        if (count === 0) {
          return {
            content: [
              { type: "text", text: `Bookmark "${args.name}" not found` },
            ],
          };
        }
        return {
          content: [{ type: "text", text: `Bookmark "${args.name}" deleted` }],
        };
      }

      // Local cache read operations
      case "get_node_tree": {
        // Auto-sync if cache is empty or stale
        await ensureCacheFresh(apiKey, db);

        const nodeId = args.node_id as string;
        const depth = Math.min(Math.max((args.depth as number) ?? 2, 1), 10);
        const format = (args.format as string) ?? "compact"; // "compact" or "json"

        // Check if cache exists
        const countResult = db.exec("SELECT COUNT(*) FROM nodes");
        const nodeCount = (countResult[0]?.values[0][0] as number) ?? 0;

        if (nodeCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Cache is empty. Run sync_nodes first.",
              },
            ],
          };
        }

        // Nodes to exclude from display (should be in bookmarks instead)
        const excludedNodes = ["AI Messages"];

        if (nodeId === "None") {
          // Get top-level nodes with children
          const nodes = buildNodeTree(db, null, depth, 0, excludedNodes);
          
          if (format === "compact") {
            const markdown = formatNodeTreeMarkdown(nodes);
            return {
              content: [
                {
                  type: "text",
                  text: markdown || "(no nodes)",
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      parent_id: null,
                      depth,
                      children: nodes,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }
        } else {
          // Get specific node with children
          const node = getNodeFromCache(db, nodeId);
          if (!node) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Node not found: ${nodeId}`,
                },
              ],
            };
          }

          // Add children to the node
          const children = buildNodeTree(db, nodeId, depth, 0, excludedNodes);
          if (children.length > 0) {
            node.children = children;
          }

          if (format === "compact") {
            let output = `**${node.name}**`;
            if (node.children_count > 0) {
              output += ` (${node.children_count} children)`;
            }
            if (node.note) {
              output += `\n\n> ${node.note}`;
            }
            if (children.length > 0) {
              output += "\n\n" + formatNodeTreeMarkdown(children, 0);
            } else if (node.children_count === 0) {
              output += "\n\n(empty)";
            }
            return {
              content: [
                {
                  type: "text",
                  text: output,
                },
              ],
            };
          } else {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(node, null, 2),
                },
              ],
            };
          }
        }
      }

      // Workflowy write operations
      case "create_node": {
        const body: Record<string, unknown> = {
          name: args.name,
          parent_id: args.parent_id,
        };
        if (args.note) body.note = args.note;
        if (args.position) body.position = args.position;
        const response = await workflowyRequest(
          apiKey,
          "/api/v1/nodes",
          "POST",
          body,
        );

        // Optimistically update cache if API succeeded
        try {
          const responseData = JSON.parse(response.content[0].text);
          // API returns { ok: true, data: { item_id: "..." } }
          const newNodeId = responseData.data?.item_id;
          if (responseData.ok && newNodeId) {
            updateNodeCache(db, "insert", {
              id: newNodeId,
              name: args.name as string,
              note: (args.note as string) || "",
              parent_id:
                args.parent_id === "None" ? null : (args.parent_id as string),
              completed: false,
            });
          }
        } catch {
          // Ignore cache update errors - will be fixed on next sync
        }

        return response;
      }

      case "update_node": {
        const nodeId = args.node_id as string;
        const completed = args.completed as boolean | undefined;

        // Handle name/note updates
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.note !== undefined) body.note = args.note;

        let response: { content: Array<{ type: "text"; text: string }> } | null =
          null;

        // If there are name/note changes, update them first
        if (Object.keys(body).length > 0) {
          response = await workflowyRequest(
            apiKey,
            `/api/v1/nodes/${nodeId}`,
            "POST",
            body,
          );
        }

        // Handle completed status change separately (uses different endpoint)
        if (completed !== undefined) {
          const endpoint = completed ? "complete" : "uncomplete";
          const completedResponse = await workflowyRequest(
            apiKey,
            `/api/v1/nodes/${nodeId}/${endpoint}`,
            "POST",
          );
          // If no previous response, use this one
          if (!response) {
            response = completedResponse;
          }
        }

        // If no changes were requested, return an error
        if (!response) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { error: "No changes specified. Provide name, note, or completed." },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Optimistically update cache
        try {
          const responseData = JSON.parse(response.content[0].text);
          if (responseData.ok) {
            updateNodeCache(db, "update", {
              id: nodeId,
              name: args.name as string | undefined,
              note: args.note as string | undefined,
              completed,
            });
          }
        } catch {
          // Ignore cache update errors
        }

        return response;
      }

      case "delete_node": {
        const response = await workflowyRequest(
          apiKey,
          `/api/v1/nodes/${args.node_id}`,
          "DELETE",
        );

        // Optimistically update cache (delete node and children)
        try {
          const responseData = JSON.parse(response.content[0].text);
          if (responseData.ok) {
            updateNodeCache(db, "delete", { id: args.node_id as string });
          }
        } catch {
          // Ignore cache update errors
        }

        return response;
      }

      case "move_node": {
        const response = await workflowyRequest(
          apiKey,
          `/api/v1/nodes/${args.node_id}/move`,
          "POST",
          {
            parent_id: args.parent_id,
          },
        );

        // Optimistically update cache
        try {
          const responseData = JSON.parse(response.content[0].text);
          if (responseData.ok) {
            updateNodeCache(db, "update", {
              id: args.node_id as string,
              parent_id:
                args.parent_id === "None" ? null : (args.parent_id as string),
            });
          }
        } catch {
          // Ignore cache update errors
        }

        return response;
      }

      // Cache and search operations
      case "search_nodes": {
        // Auto-sync if cache is empty or stale
        await ensureCacheFresh(apiKey, db);

        const query = args.query as string;
        const includeCompleted = (args.include_completed as boolean) ?? false;
        const limit = Math.min((args.limit as number) ?? 20, 100);

        // Check if cache exists
        const countResult = db.exec("SELECT COUNT(*) FROM nodes");
        const nodeCount = (countResult[0]?.values[0][0] as number) ?? 0;

        if (nodeCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "Cache is empty. Run sync_nodes first.",
                    cache_status: "empty",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Use LIKE for text search (sql.js doesn't support FTS5)
        const searchPattern = `%${query.toUpperCase()}%`;
        const completedFilter = includeCompleted ? "" : "AND completed = 0";

        // Query using LIKE pattern matching
        const results = db.exec(
          `SELECT id, name, note, parent_id, completed, children_count
           FROM nodes
           WHERE (UPPER(name) LIKE ? OR UPPER(note) LIKE ?)
           ${completedFilter}
           LIMIT ?`,
          [searchPattern, searchPattern, limit],
        );

        // Build results with paths and child previews
        const nodes =
          results[0]?.values.map((row) => {
            const nodeId = row[0] as string;
            const childrenCount = (row[5] as number) || 0;
            const nodePath = buildNodePath(db, nodeId);

            // Get first 5 children as preview (ordered by priority)
            let childrenPreview: Array<{
              name: string;
              children_count: number;
            }> = [];
            if (childrenCount > 0) {
              const childResults = db.exec(
                `SELECT name, children_count FROM nodes 
                 WHERE parent_id = ? 
                 ORDER BY priority 
                 LIMIT 5`,
                [nodeId],
              );
              if (childResults.length > 0 && childResults[0].values.length > 0) {
                childrenPreview = childResults[0].values.map((childRow) => ({
                  name: childRow[0] as string,
                  children_count: (childRow[1] as number) || 0,
                }));
              }
            }

            return {
              id: nodeId,
              name: row[1],
              note: row[2] || null,
              parent_id: row[3] || null,
              completed: row[4] === 1,
              children_count: childrenCount,
              children_preview: childrenPreview,
              path: nodePath,
              path_display: formatPathString(nodePath),
            };
          }) ?? [];

        // Get cache freshness
        const metaResult = db.exec(
          "SELECT value FROM sync_meta WHERE key = 'last_full_sync'",
        );
        const lastSync = (metaResult[0]?.values[0]?.[0] as string) ?? "never";

        // Check if stale (>1 hour)
        let isStale = true;
        if (lastSync !== "never") {
          const lastSyncDate = new Date(lastSync);
          const hoursOld =
            (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);
          isStale = hoursOld > 1;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  results: nodes,
                  total_found: nodes.length,
                  cache_last_synced: lastSync,
                  cache_is_stale: isStale,
                  cache_node_count: nodeCount,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      case "sync_nodes": {
        const result = await performFullSync(apiKey, db);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Workflowy MCP Server running on stdio");

  // Auto-sync on startup if cache is stale (>24 hours)
  try {
    const apiKey = getApiKey();
    const db = await getDb();

    // Check last sync time
    const metaResult = db.exec(
      "SELECT value FROM sync_meta WHERE key = 'last_full_sync'",
    );
    const lastSync = metaResult[0]?.values[0]?.[0] as string | undefined;

    let shouldSync = true;
    if (lastSync) {
      const lastSyncDate = new Date(lastSync);
      const hoursOld = (Date.now() - lastSyncDate.getTime()) / (1000 * 60 * 60);
      shouldSync = hoursOld > 1;
    }

    if (shouldSync) {
      console.error("Cache is stale or empty, starting background sync...");
      // Run sync in background (don't await)
      performFullSync(apiKey, db)
        .then((result) => {
          if (result.success) {
            console.error(
              `Background sync complete: ${result.nodes_synced} nodes synced`,
            );
          } else {
            console.error(`Background sync failed: ${result.error}`);
          }
        })
        .catch((err) => {
          console.error(`Background sync error: ${err}`);
        });
    } else {
      console.error("Cache is fresh, skipping auto-sync");
    }
  } catch (err) {
    // Don't fail startup if auto-sync check fails
    console.error(`Auto-sync check failed: ${err}`);
  }
}

main().catch(console.error);
