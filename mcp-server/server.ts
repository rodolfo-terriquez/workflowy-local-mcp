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
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), appName);
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

  throw new Error("Workflowy API key not configured. Please set it in the app settings.");
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
        text: JSON.stringify({ http_status: res.status, ok: res.ok, data }, null, 2),
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
          description: "A friendly name for the bookmark (e.g., 'special_inbox', 'work_tasks')",
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
    name: "list_nodes",
    description:
      "List child nodes under a parent. Always use the specified parent_id if you know it. Otherwise, use parent_id='None' for top-level nodes, or use 'inbox'/'home' for those two special locations.",
    inputSchema: {
      type: "object",
      properties: {
        parent_id: {
          type: "string",
          description: "Parent node ID: 'None' for top-level, 'inbox', 'home', or a node UUID",
        },
      },
      required: ["parent_id"],
    },
  },
  {
    name: "get_node",
    description: "Get a single node by its ID. Returns the node's name, note, and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The node UUID to retrieve" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "export_all_nodes",
    description:
      "Export all nodes from the entire Workflowy account. WARNING: Rate limited to 1 request per minute. Use sparingly.",
    inputSchema: { type: "object", properties: {} },
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
    description: "Permanently delete a node and all its children. Use with caution.",
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
          description: "New parent: 'inbox', 'home', 'None' for top-level, or a node UUID",
        },
      },
      required: ["node_id", "parent_id"],
    },
  },
  {
    name: "complete_node",
    description: "Mark a node as completed (checked off).",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "The node UUID to mark as complete",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "uncomplete_node",
    description: "Mark a node as not completed (unchecked).",
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description: "The node UUID to mark as incomplete",
        },
      },
      required: ["node_id"],
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

## Common Workflows

**Adding content to a bookmarked location:**
1. list_bookmarks to see all saved locations
2. Pick the bookmark that best matches what the user mentioned
3. create_node with that node_id as parent_id

**Exploring the hierarchy:**
1. list_nodes with parent_id='None' to see top-level nodes
2. list_nodes with a specific node_id to see its children

## Tips
- Always use list_bookmarks when the user refers to a named location, then pick the best match
- Avoid export_all_nodes unless necessary (rate limited to 1/min)
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
        description: "Get the current server instructions and context for working with Workflowy",
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
        db.run("INSERT INTO bookmarks (name, node_id) VALUES (?, ?)", [args.name, args.node_id]);
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
        const results = db.exec("SELECT name, node_id, created_at FROM bookmarks ORDER BY name");
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
        const before = db.exec("SELECT COUNT(*) FROM bookmarks WHERE name = ?", [args.name]);
        const count = before.length > 0 ? (before[0].values[0][0] as number) : 0;
        db.run("DELETE FROM bookmarks WHERE name = ?", [args.name]);
        saveDb();
        if (count === 0) {
          return {
            content: [{ type: "text", text: `Bookmark "${args.name}" not found` }],
          };
        }
        return {
          content: [{ type: "text", text: `Bookmark "${args.name}" deleted` }],
        };
      }

      // Workflowy read operations
      case "list_nodes":
        return workflowyRequest(
          apiKey,
          `/api/v1/nodes?parent_id=${encodeURIComponent(args.parent_id)}`,
          "GET",
        );

      case "get_node":
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}`, "GET");

      case "export_all_nodes":
        return workflowyRequest(apiKey, "/api/v1/nodes-export", "GET");

      case "get_targets":
        return workflowyRequest(apiKey, "/api/v1/targets", "GET");

      // Workflowy write operations
      case "create_node": {
        const body: Record<string, unknown> = {
          name: args.name,
          parent_id: args.parent_id,
        };
        if (args.note) body.note = args.note;
        return workflowyRequest(apiKey, "/api/v1/nodes", "POST", body);
      }

      case "update_node": {
        const body: Record<string, unknown> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.note !== undefined) body.note = args.note;
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}`, "POST", body);
      }

      case "delete_node":
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}`, "DELETE");

      case "move_node":
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}/move`, "POST", {
          parent_id: args.parent_id,
        });

      case "complete_node":
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}/complete`, "POST");

      case "uncomplete_node":
        return workflowyRequest(apiKey, `/api/v1/nodes/${args.node_id}/uncomplete`, "POST");

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Workflowy MCP Server running on stdio");
}

main().catch(console.error);
