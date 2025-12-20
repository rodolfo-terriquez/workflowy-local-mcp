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

  // Create table if it doesn't exist
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      name TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create nodes cache table
  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      note TEXT DEFAULT '',
      parent_id TEXT,
      completed INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    )
  `);

  // Create indexes for efficient querying
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_parent_id ON nodes(parent_id)`,
  );
  dbInstance.run(
    `CREATE INDEX IF NOT EXISTS idx_nodes_completed ON nodes(completed)`,
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
        createdAt?: number;
        modifiedAt?: number;
      }>;
    };

    const nodes = responseData.nodes || [];

    // Transactional update
    db.run("BEGIN TRANSACTION");
    db.run("DELETE FROM nodes");

    for (const node of nodes) {
      db.run(
        "INSERT INTO nodes (id, name, note, parent_id, completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          node.id,
          node.name || "",
          node.note || "",
          node.parent_id || null,
          node.completed ? 1 : 0,
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
  children?: NodeTree[];
}

function buildNodeTree(
  db: Database,
  nodeId: string | null,
  depth: number,
  currentDepth: number = 0,
): NodeTree[] {
  if (currentDepth >= depth) {
    return [];
  }

  // Query children of this node
  const parentCondition =
    nodeId === null ? "parent_id IS NULL" : "parent_id = ?";
  const params = nodeId === null ? [] : [nodeId];

  const results = db.exec(
    `SELECT id, name, note, parent_id, completed FROM nodes WHERE ${parentCondition} ORDER BY name`,
    params,
  );

  if (results.length === 0 || results[0].values.length === 0) {
    return [];
  }

  return results[0].values.map((row) => {
    const node: NodeTree = {
      id: row[0] as string,
      name: row[1] as string,
      note: (row[2] as string) || null,
      parent_id: (row[3] as string) || null,
      completed: row[4] === 1,
    };

    // Recursively get children if we haven't reached max depth
    if (currentDepth + 1 < depth) {
      const children = buildNodeTree(db, node.id, depth, currentDepth + 1);
      if (children.length > 0) {
        node.children = children;
      }
    }

    return node;
  });
}

// Get a single node by ID from local cache
function getNodeFromCache(db: Database, nodeId: string): NodeTree | null {
  const results = db.exec(
    "SELECT id, name, note, parent_id, completed FROM nodes WHERE id = ?",
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
      "Save a Workflowy node ID with a friendly name for easy reference later. Check similar bookmarks before creating a new one to avoid duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "A friendly name for the bookmark (e.g., 'special_inbox', 'work_tasks')",
        },
        node_id: {
          type: "string",
          description: "The Workflowy node UUID to bookmark",
        },
      },
      required: ["name", "node_id"],
    },
  },
  {
    name: "list_bookmarks",
    description:
      "List all saved Workflowy bookmarks. Use this to see what locations have been bookmarked.",
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
      "Get a node and its nested children from the local cache. Returns the node with its hierarchy up to the specified depth. Use sync_nodes first if cache is empty.",
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
      },
      required: ["node_id"],
    },
  },
  {
    name: "get_targets",
    description:
      "Get special Workflowy targets like 'inbox' and 'home'. Useful for discovering available special locations.",
    inputSchema: { type: "object", properties: {} },
  },
  // Workflowy write tools
  {
    name: "create_node",
    description:
      "Create a new node (bullet point) in Workflowy. The node will be added as a child of the specified parent.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The text content of the node" },
        parent_id: {
          type: "string",
          description:
            "Where to create the node: 'inbox', 'home', 'None' for top-level, or a node UUID",
        },
        note: {
          type: "string",
          description: "Optional note/description for the node",
        },
      },
      required: ["name", "parent_id"],
    },
  },
  {
    name: "update_node",
    description: "Update an existing node's name or note.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node UUID to update" },
        name: { type: "string", description: "New name/text for the node" },
        note: { type: "string", description: "New note for the node" },
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
  {
    name: "set_completed",
    description: "Set a node's completed status (checked/unchecked).",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "The node UUID to update",
        },
        completed: {
          type: "boolean",
          description: "True to mark complete, false to mark incomplete",
        },
      },
      required: ["node_id", "completed"],
    },
  },
  // Cache and search tools
  {
    name: "search_nodes",
    description:
      "Search locally cached Workflowy nodes by text. Returns matching nodes with their full path. Use sync_nodes first if cache is empty or stale.",
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
- Nodes can be nested under other nodes (parent_id)
- Special locations: 'inbox', 'home', or 'None' (top-level)

## Bookmarks
Bookmarks let you save node IDs with friendly names. When a user mentions a named location (like "my work inbox" or "project notes"), use list_bookmarks to see all saved bookmarks and pick the one that best matches what the user is referring to.

## Local Search
The server maintains a local cache of all nodes for fast searching:

- Use search_nodes to find nodes by text in name or note fields
- Results include the full path to each node and the node ID
- Cache syncs automatically when empty or stale (>1 hour)
- Use sync_nodes to manually force a refresh if needed (1/min rate limit)
- Cache updates automatically after create/update/delete/move/complete operations

## Common Workflows

**Finding and modifying content:**
1. search_nodes with relevant keywords
2. Use the returned node_id with update_node, delete_node, move_node, etc.

**Adding content to a bookmarked location:**
1. list_bookmarks to see all saved locations
2. Pick the bookmark that best matches what the user mentioned
3. create_node with that node_id as parent_id

**Exploring the hierarchy:**
1. get_node_tree with node_id='None' to see top-level nodes with children
2. get_node_tree with a specific node_id and depth to explore nested content

## Tips
- Use search_nodes first when looking for specific content
- Use get_node_tree to explore node hierarchies from the local cache
- Always use list_bookmarks when the user refers to a named location
- Node names support basic formatting and markdown`;

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
        // Delete existing bookmark with same name if exists
        db.run("DELETE FROM bookmarks WHERE name = ?", [args.name]);
        db.run("INSERT INTO bookmarks (name, node_id) VALUES (?, ?)", [
          args.name,
          args.node_id,
        ]);
        saveDb();
        return {
          content: [
            {
              type: "text",
              text: `Bookmark "${args.name}" saved with node ID: ${args.node_id}`,
            },
          ],
        };
      }

      case "list_bookmarks": {
        const results = db.exec(
          "SELECT name, node_id, created_at FROM bookmarks ORDER BY name",
        );
        const rows =
          results.length > 0
            ? results[0].values.map((row) => ({
                name: row[0],
                node_id: row[1],
                created_at: row[2],
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

        if (nodeId === "None") {
          // Get top-level nodes with children
          const nodes = buildNodeTree(db, null, depth, 0);
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
        } else {
          // Get specific node with children
          const node = getNodeFromCache(db, nodeId);
          if (!node) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      error: `Node not found: ${nodeId}`,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          // Add children to the node
          const children = buildNodeTree(db, nodeId, depth, 0);
          if (children.length > 0) {
            node.children = children;
          }

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

      case "get_targets":
        return workflowyRequest(apiKey, "/api/v1/targets", "GET");

      // Workflowy write operations
      case "create_node": {
        const body: Record<string, unknown> = {
          name: args.name,
          parent_id: args.parent_id,
        };
        if (args.note) body.note = args.note;
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
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.note !== undefined) body.note = args.note;
        const response = await workflowyRequest(
          apiKey,
          `/api/v1/nodes/${args.node_id}`,
          "POST",
          body,
        );

        // Optimistically update cache
        try {
          const responseData = JSON.parse(response.content[0].text);
          if (responseData.ok) {
            updateNodeCache(db, "update", {
              id: args.node_id as string,
              name: args.name as string | undefined,
              note: args.note as string | undefined,
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

      case "set_completed": {
        const completed = args.completed as boolean;
        const endpoint = completed ? "complete" : "uncomplete";
        const response = await workflowyRequest(
          apiKey,
          `/api/v1/nodes/${args.node_id}/${endpoint}`,
          "POST",
        );

        // Optimistically update cache
        try {
          const responseData = JSON.parse(response.content[0].text);
          if (responseData.ok) {
            updateNodeCache(db, "update", {
              id: args.node_id as string,
              completed,
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

        // Build search query
        const searchPattern = `%${query.toUpperCase()}%`;
        const completedFilter = includeCompleted ? "" : "AND completed = 0";

        const results = db.exec(
          `SELECT id, name, note, parent_id, completed
           FROM nodes
           WHERE (UPPER(name) LIKE ? OR UPPER(note) LIKE ?)
           ${completedFilter}
           LIMIT ?`,
          [searchPattern, searchPattern, limit],
        );

        // Build results with paths
        const nodes =
          results[0]?.values.map((row) => {
            const nodePath = buildNodePath(db, row[0] as string);
            return {
              id: row[0],
              name: row[1],
              note: row[2] || null,
              parent_id: row[3] || null,
              completed: row[4] === 1,
              path: nodePath,
              path_display: formatPathString(nodePath),
            };
          }) ?? [];

        // Get cache freshness
        const metaResult = db.exec(
          "SELECT value FROM sync_meta WHERE key = 'last_full_sync'",
        );
        const lastSync = (metaResult[0]?.values[0]?.[0] as string) ?? "never";

        // Check if stale (>24 hours)
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
