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
import { defaultServerInstructions, toolDescriptions } from "../shared/constants.js";

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

// MCP Log entry interface
interface McpLogEntry {
  timestamp: string;
  message: string;
  type: "info" | "success" | "error" | "warning";
  source: "mcp";
}

// Write log entry to shared mcp-logs.json file
function writeMcpLog(message: string, type: McpLogEntry["type"] = "info"): void {
  try {
    const dataDir = getDataDir();
    const logPath = path.join(dataDir, "mcp-logs.json");
    
    // Read existing logs
    let logs: McpLogEntry[] = [];
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, "utf-8");
        logs = JSON.parse(content);
      } catch {
        // If file is corrupted, start fresh
        logs = [];
      }
    }
    
    // Add new entry
    const entry: McpLogEntry = {
      timestamp: new Date().toISOString(),
      message,
      type,
      source: "mcp",
    };
    logs.push(entry);
    
    // Keep only last 200 entries
    if (logs.length > 200) {
      logs = logs.slice(-200);
    }
    
    // Write back
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  } catch {
    // Silently fail - don't let logging errors break the server
  }
}

// Rate limiting for nodes-export endpoint (1 request per minute)
let lastExportRequestTime: number = 0;
const EXPORT_RATE_LIMIT_MS = 60000; // 1 minute

// Stale threshold for cache (1 hour)
const STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// Reserved bookmark name for AI instructions
const AI_INSTRUCTIONS_BOOKMARK = "ai_instructions";

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

  // Check if sync already in progress (with stale lock detection)
  const inProgressResult = db.exec(
    "SELECT value FROM sync_meta WHERE key = 'sync_in_progress'",
  );
  const syncStartResult = db.exec(
    "SELECT value FROM sync_meta WHERE key = 'sync_started_at'",
  );
  
  if (
    inProgressResult.length > 0 &&
    inProgressResult[0].values[0][0] === "true"
  ) {
    // Check if the lock is stale (>5 minutes old)
    const syncStartedAt = syncStartResult[0]?.values[0]?.[0] as string | undefined;
    if (syncStartedAt) {
      const startTime = new Date(syncStartedAt).getTime();
      const elapsed = Date.now() - startTime;
      const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes
      
      if (elapsed < STALE_LOCK_MS) {
        return {
          success: false,
          error: "Sync already in progress.",
        };
      }
      // Lock is stale, clear it and proceed
      writeMcpLog("Clearing stale sync lock (was stuck for >5 minutes)", "warning");
    }
  }

  // Mark sync in progress with timestamp
  db.run(
    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_in_progress', 'true')",
  );
  db.run(
    "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_started_at', ?)",
    [new Date().toISOString()],
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

// Sync a single node from the API and update cache
async function syncSingleNode(
  apiKey: string,
  db: Database,
  nodeId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const url = `https://workflowy.com/api/v1/nodes/${nodeId}`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        // Node was deleted - remove from cache
        db.run("DELETE FROM nodes WHERE id = ?", [nodeId]);
        saveDb();
        return { success: true };
      }
      throw new Error(`API error: ${res.status} ${res.statusText}`);
    }

    const responseData = (await res.json()) as {
      node: {
        id: string;
        name?: string;
        note?: string;
        priority?: number;
        completedAt?: number | null;
        createdAt?: number;
        modifiedAt?: number;
      };
    };

    const node = responseData.node;
    if (!node) {
      return { success: false, error: "No node in response" };
    }

    // Update or insert the node (preserve parent_id and children_count from cache)
    const existingResult = db.exec(
      "SELECT parent_id, children_count FROM nodes WHERE id = ?",
      [node.id],
    );
    const parentId = existingResult[0]?.values[0]?.[0] as string | null;
    const childrenCount = (existingResult[0]?.values[0]?.[1] as number) ?? 0;

    db.run(
      `INSERT OR REPLACE INTO nodes (id, name, note, parent_id, completed, children_count, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        node.id,
        node.name || "",
        node.note || "",
        parentId,
        node.completedAt ? 1 : 0,
        childrenCount,
        node.priority || 0,
        node.createdAt ? new Date(node.createdAt * 1000).toISOString() : null,
        node.modifiedAt ? new Date(node.modifiedAt * 1000).toISOString() : null,
      ],
    );
    saveDb();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Sync children of a node from the API and update cache (1 level only)
async function syncNodeChildren(
  apiKey: string,
  db: Database,
  parentId: string | null, // null for top-level, "inbox"/"home" for targets, or UUID
): Promise<{ success: boolean; error?: string }> {
  try {
    // Build the URL with parent_id query param
    let url = "https://workflowy.com/api/v1/nodes";
    if (parentId === null) {
      url += "?parent_id=None";
    } else {
      url += `?parent_id=${encodeURIComponent(parentId)}`;
    }

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
        priority?: number;
        completedAt?: number | null;
        createdAt?: number;
        modifiedAt?: number;
      }>;
    };

    const nodes = responseData.nodes || [];
    
    writeMcpLog(`[syncNodeChildren] Parent: ${parentId}, API returned ${nodes.length} children`, "info");
    if (nodes.length > 0) {
      writeMcpLog(`[syncNodeChildren] Children: ${nodes.map(n => n.name?.substring(0, 30)).join(', ')}`, "info");
    }

    // Get existing children from cache to detect deletions
    const parentCondition = parentId === null ? "parent_id IS NULL" : "parent_id = ?";
    const params = parentId === null ? [] : [parentId];
    const existingResult = db.exec(
      `SELECT id FROM nodes WHERE ${parentCondition}`,
      params,
    );
    const existingIds = new Set(
      existingResult[0]?.values.map((row) => row[0] as string) || [],
    );

    // Track which nodes we've seen from the API
    const seenIds = new Set<string>();

    // Update or insert each child node
    for (const node of nodes) {
      seenIds.add(node.id);

      // Get existing children_count from cache (we don't want to reset it)
      const childCountResult = db.exec(
        "SELECT children_count FROM nodes WHERE id = ?",
        [node.id],
      );
      const childrenCount = (childCountResult[0]?.values[0]?.[0] as number) ?? 0;

      db.run(
        `INSERT OR REPLACE INTO nodes (id, name, note, parent_id, completed, children_count, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          node.id,
          node.name || "",
          node.note || "",
          parentId,
          node.completedAt ? 1 : 0,
          childrenCount,
          node.priority || 0,
          node.createdAt ? new Date(node.createdAt * 1000).toISOString() : null,
          node.modifiedAt ? new Date(node.modifiedAt * 1000).toISOString() : null,
        ],
      );
    }

    // Remove nodes that no longer exist (deleted in Workflowy)
    for (const existingId of existingIds) {
      if (!seenIds.has(existingId as string)) {
        // Recursively delete this node and all its descendants from cache
        deleteNodeFromCache(db, existingId as string);
      }
    }

    // Update parent's children_count
    if (parentId && parentId !== "inbox" && parentId !== "home" && parentId !== "None") {
      db.run(
        "UPDATE nodes SET children_count = ? WHERE id = ?",
        [nodes.length, parentId],
      );
    }

    saveDb();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Helper to recursively delete a node and its descendants from cache
function deleteNodeFromCache(db: Database, nodeId: string): void {
  // Get all children first
  const childrenResult = db.exec(
    "SELECT id FROM nodes WHERE parent_id = ?",
    [nodeId],
  );
  const childIds = childrenResult[0]?.values.map((row) => row[0] as string) || [];

  // Recursively delete children
  for (const childId of childIds) {
    deleteNodeFromCache(db, childId);
  }

  // Delete this node
  db.run("DELETE FROM nodes WHERE id = ?", [nodeId]);
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

// --- Fuzzy Search Helpers ---

// Generate trigrams (3-character sliding windows) from a string
function getTrigrams(s: string): Set<string> {
  const trigrams = new Set<string>();
  const normalized = s.toLowerCase();
  // Pad with spaces so we also capture word boundaries
  const padded = `  ${normalized}  `;
  for (let i = 0; i < padded.length - 2; i++) {
    trigrams.add(padded.substring(i, i + 3));
  }
  return trigrams;
}

// Compute trigram similarity between two strings (0 to 1)
function trigramSimilarity(a: string, b: string): number {
  const trigramsA = getTrigrams(a);
  const trigramsB = getTrigrams(b);
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  // Dice coefficient: 2 * |intersection| / (|A| + |B|)
  return (2 * intersection) / (trigramsA.size + trigramsB.size);
}

// Tokenize text into words, stripping HTML tags and punctuation
function tokenizeWords(text: string): string[] {
  // Strip HTML tags
  const stripped = text.replace(/<[^>]*>/g, " ");
  // Split on non-alphanumeric, keep words of length > 0
  return stripped.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 0);
}

// Check how well a query word matches a single text word
// Returns 0 to 1: distinguishes exact word match, prefix, and substring-within-word
function wordMatchScore(queryWord: string, textWord: string): number {
  // Exact word match
  if (queryWord === textWord) return 1.0;
  // Query is a prefix of the text word (e.g. "double" matches "doubling")
  if (textWord.startsWith(queryWord) && queryWord.length >= 3) return 0.9;
  // Text word is a prefix of the query (e.g. "grocery" vs "grocer")
  if (queryWord.startsWith(textWord) && textWord.length >= 3) return 0.8;
  // Substring within a larger word (e.g. "body" in "somebody") — penalize heavily
  if (textWord.includes(queryWord) && queryWord.length >= 3) return 0.3;
  // Trigram similarity for typo tolerance
  const sim = trigramSimilarity(queryWord, textWord);
  return sim >= 0.4 ? sim * 0.7 : 0; // Scale down trigram matches slightly
}

// Find the best match score for a query word against all text words
function bestWordMatch(queryWord: string, textWords: string[]): number {
  let best = 0;
  for (const tw of textWords) {
    const s = wordMatchScore(queryWord, tw);
    if (s > best) {
      best = s;
      if (best >= 1.0) break; // Can't do better than exact
    }
  }
  return best;
}

// Score a candidate node against a search query
// Returns a score from 0 (no match) to 1+ (perfect match)
function scoreCandidate(
  query: string,
  queryWords: string[],
  nodeName: string,
  nodeNote: string,
): number {
  const nameLower = nodeName.toLowerCase();
  const noteLower = nodeNote.toLowerCase();
  // Strip HTML for matching
  const nameStripped = nameLower.replace(/<[^>]*>/g, " ");
  const noteStripped = noteLower.replace(/<[^>]*>/g, " ");
  const combinedStripped = `${nameStripped} ${noteStripped}`;
  const queryLower = query.toLowerCase();

  const nameTokens = tokenizeWords(nodeName);
  const noteTokens = tokenizeWords(nodeNote);
  const allTokens = [...nameTokens, ...noteTokens];

  // --- Component 1: Exact phrase match (strongest signal) ---
  // Full query appears as a contiguous substring
  const exactInName = nameStripped.includes(queryLower) ? 1.0 : 0;
  const exactInNote = noteStripped.includes(queryLower) ? 0.8 : 0;
  const exactMatch = Math.max(exactInName, exactInNote);

  // --- Component 2: All-words-present match ---
  // Every query word matches a word in the text (as whole word, prefix, or fuzzy)
  let allWordsNameScore = 0;
  let allWordsAllScore = 0;
  if (queryWords.length > 0) {
    let nameSum = 0;
    let allSum = 0;
    for (const qw of queryWords) {
      nameSum += bestWordMatch(qw, nameTokens);
      allSum += bestWordMatch(qw, allTokens);
    }
    allWordsNameScore = nameSum / queryWords.length;
    allWordsAllScore = allSum / queryWords.length;
  }

  // --- Component 3: Trigram similarity of full query vs name ---
  // Helps with reordering and heavy typos, but only on shorter text
  // (long text dilutes the signal)
  let trigramScore = 0;
  if (nameTokens.length <= 15) {
    trigramScore = trigramSimilarity(queryLower, nameStripped);
  }

  // --- Composite score ---
  // Heavily favor exact phrase match, then all-words-in-name, then all-words-anywhere
  const score =
    exactMatch * 0.45 +
    allWordsNameScore * 0.30 +
    allWordsAllScore * 0.10 +
    trigramScore * 0.15;

  return score;
}

// Minimum score threshold to include in results
const FUZZY_SEARCH_THRESHOLD = 0.2;

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

// Fetch user's AI instructions from the ai_instructions bookmark
// Returns the node tree as formatted text, or null if not found
function getAIInstructions(db: Database): string | null {
  // Check if ai_instructions bookmark exists
  const bookmarkResult = db.exec(
    "SELECT node_id FROM bookmarks WHERE name = ?",
    [AI_INSTRUCTIONS_BOOKMARK],
  );

  if (bookmarkResult.length === 0 || bookmarkResult[0].values.length === 0) {
    return null;
  }

  const nodeId = bookmarkResult[0].values[0][0] as string;

  // Get the node and its children (depth 3 for reasonable instruction nesting)
  const node = getNodeFromCache(db, nodeId);
  if (!node) {
    return null;
  }

  // Build the tree with children
  const children = buildNodeTree(db, nodeId, 3, 0);
  
  // Format as simple text for instructions
  const lines: string[] = [];
  
  // Add the parent node's note if it has one (main instructions)
  if (node.note && node.note.trim()) {
    lines.push(node.note.trim());
    lines.push("");
  }
  
  // Format children as instruction items
  function formatInstructionNodes(nodes: NodeTree[], indent: number = 0): void {
    for (const n of nodes) {
      const prefix = "  ".repeat(indent) + "- ";
      lines.push(prefix + n.name);
      if (n.note && n.note.trim()) {
        lines.push("  ".repeat(indent + 1) + n.note.trim());
      }
      if (n.children && n.children.length > 0) {
        formatInstructionNodes(n.children, indent + 1);
      }
    }
  }
  
  formatInstructionNodes(children);
  
  return lines.length > 0 ? lines.join("\n") : null;
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

// LLM Doc API base URL
const LLM_DOC_API_BASE = "https://beta.workflowy.com";

// LLM Doc API: Read a node and its children
// Returns tag-as-key JSON format
async function llmDocRead(
  apiKey: string,
  nodeId: string,
  depth: number = 3,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = `${LLM_DOC_API_BASE}/api/llm/doc/read/${encodeURIComponent(nodeId)}/?depth=${depth}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: true, http_status: res.status, message: data },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// LLM Doc API: Edit nodes (insert, update, delete operations)
interface LlmDocOperation {
  op: "insert" | "update" | "delete";
  under?: string; // For insert: parent tag or target (today, inbox, etc.)
  items?: Array<{
    n: string; // Name/text
    l?: string; // Line type (todo, h1, h2, h3, bullets, code, quote)
    x?: number; // Completion status (1 = complete, 0 = incomplete)
    c?: unknown[]; // Children for nested structures
  }>;
  position?: "top" | "bottom"; // For insert
  ref?: string; // For update/delete: tag of node to modify
  to?: {
    n?: string; // New name
    l?: string; // New line type
    x?: number; // New completion status
  };
}

async function llmDocEdit(
  apiKey: string,
  root: string,
  operations: LlmDocOperation[],
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const url = `${LLM_DOC_API_BASE}/api/llm/doc/edit`;

  const body = {
    root,
    operations,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: true, http_status: res.status, message: data, request: body },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: true, response: data }, null, 2),
      },
    ],
  };
}

// Default tool definitions - descriptions imported from shared/constants.ts
const defaultTools = [
  // This tool MUST be first - it's the entry point for every conversation
  {
    name: "list_bookmarks",
    description: toolDescriptions.list_bookmarks,
    inputSchema: { type: "object", properties: {} },
  },
  // Bookmark tools
  {
    name: "save_bookmark",
    description: toolDescriptions.save_bookmark,
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
          description: "The Workflowy node ID (12-hex tag or UUID) to bookmark",
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
    name: "delete_bookmark",
    description: toolDescriptions.delete_bookmark,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The bookmark name to delete" },
      },
      required: ["name"],
    },
  },
  // LLM Doc API tools
  {
    name: "read_doc",
    description: toolDescriptions.read_doc,
    inputSchema: {
      type: "object",
      properties: {
        node_id: {
          type: "string",
          description:
            "The node to read: a 12-hex tag, full UUID, or special target ('today', 'tomorrow', 'next_week', 'inbox', 'None' for root)",
        },
        depth: {
          type: "number",
          description:
            "How many levels of children to include (default: 3, max: 10)",
        },
      },
      required: ["node_id"],
    },
  },
  {
    name: "edit_doc",
    description: toolDescriptions.edit_doc,
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description:
            "The subtree root: a tag from a prior read_doc, or a target like 'today', 'inbox', 'None'",
        },
        operations: {
          type: "array",
          description: "Array of operations to perform",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: ["insert", "update", "delete"],
                description: "Operation type",
              },
              under: {
                type: "string",
                description: "For insert: parent tag or target (today, inbox, etc.)",
              },
              items: {
                type: "array",
                description: "For insert: nodes to create",
                items: {
                  type: "object",
                  properties: {
                    n: { type: "string", description: "Name/text content" },
                    l: {
                      type: "string",
                      enum: ["todo", "h1", "h2", "h3", "bullets", "code", "quote"],
                      description: "Line type",
                    },
                    x: {
                      type: "number",
                      enum: [0, 1],
                      description: "Completion status (1 = complete)",
                    },
                    c: {
                      type: "array",
                      description: "Children for nested structures",
                    },
                  },
                  required: ["n"],
                },
              },
              position: {
                type: "string",
                enum: ["top", "bottom"],
                description: "For insert: where to place nodes (default: top)",
              },
              ref: {
                type: "string",
                description: "For update/delete: tag of node to modify",
              },
              to: {
                type: "object",
                description: "For update: new values",
                properties: {
                  n: { type: "string", description: "New name" },
                  l: { type: "string", description: "New line type" },
                  x: { type: "number", description: "New completion status" },
                },
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["root", "operations"],
    },
  },
  // Cache and search tools
  {
    name: "search_nodes",
    description: toolDescriptions.search_nodes,
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
          description: "Maximum results to return (default: 5, max: 100)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "sync_nodes",
    description: toolDescriptions.sync_nodes,
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

// Default server instructions are imported from shared/constants.ts

// Get server instructions dynamically, including user's custom AI instructions
function getServerInstructions(db: Database | null): string {
  const config = loadConfig();
  const baseInstructions = config.serverDescription || defaultServerInstructions;
  
  // Try to append user's custom AI instructions from Workflowy
  if (db) {
    const userInstructions = getAIInstructions(db);
    if (userInstructions) {
      return `${baseInstructions}

## User's Custom Instructions
The user has configured the following custom instructions in their Workflowy "AI Instructions" node. Follow these preferences:

${userInstructions}`;
    }
  }
  
  return baseInstructions;
}

// Main server setup
async function main() {
  // Initialize DB early so we can load user's custom instructions for the server
  const db = await getDb();
  
  // Try to sync ai_instructions bookmark children before loading instructions
  // This ensures we have fresh data at startup
  try {
    const apiKey = getApiKey();
    const bookmarkResult = db.exec(
      "SELECT node_id FROM bookmarks WHERE name = ?",
      [AI_INSTRUCTIONS_BOOKMARK],
    );
    if (bookmarkResult.length > 0 && bookmarkResult[0].values.length > 0) {
      const nodeId = bookmarkResult[0].values[0][0] as string;
      await syncNodeChildren(apiKey, db, nodeId).catch(() => {});
    }
  } catch {
    // Ignore errors - may not have API key configured yet
  }
  
  const serverInstructions = getServerInstructions(db);
  
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
      instructions: serverInstructions,
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
      // Get db to load user's custom AI instructions
      const db = await getDb();
      
      // Auto-sync at the start of each conversation (if cache is stale)
      try {
        const apiKey = getApiKey();
        await ensureCacheFresh(apiKey, db);
      } catch (e) {
        // Ignore sync errors - instructions can still be returned
        writeMcpLog(`Auto-sync on conversation start failed: ${e}`, "warning");
      }
      
      return {
        description: "Server instructions for working with Workflowy",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: getServerInstructions(db),
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
        const name = args?.name as string;
        const nodeId = args?.node_id as string;
        const context = (args?.context as string) || null;

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
                name: row[0] as string,
                node_id: row[1] as string,
                context: row[2] || null,
                created_at: row[3],
              }))
            : [];
        
        // Sync children of each bookmarked node
        // For ai_instructions, we await to ensure fresh data for the response
        // For others, sync in background
        const aiInstructionsBookmark = rows.find(r => r.name === AI_INSTRUCTIONS_BOOKMARK);
        
        // Await sync for ai_instructions so we get fresh data
        if (aiInstructionsBookmark?.node_id) {
          await syncNodeChildren(apiKey, db, aiInstructionsBookmark.node_id).catch(() => {});
        }
        
        // Sync other bookmarks in background
        for (const row of rows) {
          if (row.node_id && row.name !== AI_INSTRUCTIONS_BOOKMARK) {
            syncNodeChildren(apiKey, db, row.node_id).catch(() => {});
          }
        }
        
        // Check if ai_instructions bookmark exists and get the instructions
        const aiInstructions = getAIInstructions(db);
        
        // Build response with clear guidance for the LLM
        const response: {
          _instructions: string;
          bookmarks: typeof rows;
          user_instructions?: string;
          action_required?: string;
        } = {
          _instructions: "READ THIS FIRST: Check user_instructions below for the user's custom AI preferences. Follow them for this entire conversation.",
          bookmarks: rows,
        };
        
        if (aiInstructions) {
          response.user_instructions = aiInstructions;
        } else if (!aiInstructionsBookmark) {
          // No bookmark exists yet - tell LLM to search for it
          response.action_required = "No 'ai_instructions' bookmark found. Search for a node named 'AI Instructions' in Workflowy using search_nodes. If found, read it with read_doc and save it as bookmark 'ai_instructions' for future sessions.";
        } else {
          // Bookmark exists but node is empty
          response.user_instructions = "(No custom instructions configured yet)";
        }
        
        return {
          content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        };
      }

      case "delete_bookmark": {
        const bookmarkName = args?.name as string;
        const before = db.exec(
          "SELECT COUNT(*) FROM bookmarks WHERE name = ?",
          [bookmarkName],
        );
        const count =
          before.length > 0 ? (before[0].values[0][0] as number) : 0;
        db.run("DELETE FROM bookmarks WHERE name = ?", [bookmarkName]);
        saveDb();
        if (count === 0) {
          return {
            content: [
              { type: "text", text: `Bookmark "${bookmarkName}" not found` },
            ],
          };
        }
        return {
          content: [{ type: "text", text: `Bookmark "${bookmarkName}" deleted` }],
        };
      }

      // LLM Doc API operations
      case "read_doc": {
        const nodeId = args?.node_id as string;
        const depth = Math.min(Math.max((args?.depth as number) ?? 3, 1), 10);

        writeMcpLog(`[read_doc] Reading node: ${nodeId}, depth: ${depth}`, "info");
        
        return llmDocRead(apiKey, nodeId, depth);
      }

      case "edit_doc": {
        const root = args?.root as string;
        const operations = args?.operations as LlmDocOperation[];

        if (!root) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing required parameter: root" }, null, 2),
              },
            ],
          };
        }

        if (!operations || !Array.isArray(operations) || operations.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "Missing or empty operations array" }, null, 2),
              },
            ],
          };
        }

        writeMcpLog(`[edit_doc] Editing root: ${root}, operations: ${JSON.stringify(operations)}`, "info");
        
        return llmDocEdit(apiKey, root, operations);
      }

      // Cache and search operations
      case "search_nodes": {
        // Auto-sync if cache is empty or stale
        await ensureCacheFresh(apiKey, db);

        const query = args?.query as string;
        const includeCompleted = (args?.include_completed as boolean) ?? false;
        const limit = Math.min((args?.limit as number) ?? 5, 100);

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

        // --- Fuzzy search: Stage 1 - SQL pre-filtering ---
        // Split query into words for independent matching
        const queryWords = tokenizeWords(query);
        const completedFilter = includeCompleted ? "" : "AND completed = 0";

        // Three-pass strategy (results merged, deduplicated by node ID):
        //
        // Pass 1: EXACT PHRASE — full query as contiguous substring (no LIMIT)
        //         These are guaranteed best matches; we never want to miss them.
        //
        // Pass 2: AND — all query words present as substrings (LIMIT 200)
        //         Catches word reordering: "doubling body" finds "body doubling".
        //         Moderate limit since AND is fairly selective.
        //
        // Pass 3: OR — any query word present (LIMIT 200)
        //         Broadest net for single-word partial/fuzzy matches.
        //         Capped to avoid pulling in too much noise.
        //
        // JS scoring then ranks and filters the merged candidates.

        const seenIds = new Set<string>();
        const mergedValues: (initSqlJs.SqlValue[])[] = [];
        const columns = ["id", "name", "note", "parent_id", "completed", "children_count"];

        function addResults(queryResult: initSqlJs.QueryExecResult[]): void {
          if (queryResult.length > 0 && queryResult[0].values.length > 0) {
            for (const row of queryResult[0].values) {
              const id = row[0] as string;
              if (!seenIds.has(id)) {
                seenIds.add(id);
                mergedValues.push(row);
              }
            }
          }
        }

        // --- Pass 1: Exact phrase match (no LIMIT — these are the best matches) ---
        const phrasePattern = `%${query.toUpperCase()}%`;
        addResults(db.exec(
          `SELECT id, name, note, parent_id, completed, children_count
           FROM nodes
           WHERE (UPPER(name) LIKE ? OR UPPER(note) LIKE ?)
           ${completedFilter}`,
          [phrasePattern, phrasePattern],
        ));

        if (queryWords.length >= 2) {
          // --- Pass 2: AND — all words present (LIMIT 200) ---
          const andClauses: string[] = [];
          const andParams: (string | number)[] = [];
          for (const word of queryWords) {
            const pattern = `%${word.toUpperCase()}%`;
            andClauses.push("(UPPER(name) LIKE ? OR UPPER(note) LIKE ?)");
            andParams.push(pattern, pattern);
          }
          andParams.push(200);

          addResults(db.exec(
            `SELECT id, name, note, parent_id, completed, children_count
             FROM nodes
             WHERE (${andClauses.join(" AND ")})
             ${completedFilter}
             LIMIT ?`,
            andParams,
          ));

          // --- Pass 3: OR — any word present (LIMIT 200) ---
          const orClauses: string[] = [];
          const orParams: (string | number)[] = [];
          for (const word of queryWords) {
            const pattern = `%${word.toUpperCase()}%`;
            orClauses.push("(UPPER(name) LIKE ? OR UPPER(note) LIKE ?)");
            orParams.push(pattern, pattern);
          }
          orParams.push(200);

          addResults(db.exec(
            `SELECT id, name, note, parent_id, completed, children_count
             FROM nodes
             WHERE (${orClauses.join(" OR ")})
             ${completedFilter}
             LIMIT ?`,
            orParams,
          ));
        }

        const results: initSqlJs.QueryExecResult[] = mergedValues.length > 0
          ? [{ columns, values: mergedValues }]
          : [];

        // --- Fuzzy search: Stage 2 - JS scoring and ranking ---
        const scoredCandidates: Array<{
          row: (string | number | null)[];
          score: number;
        }> = [];

        if (results.length > 0 && results[0].values.length > 0) {
          for (const row of results[0].values) {
            const nodeName = (row[1] as string) || "";
            const nodeNote = (row[2] as string) || "";
            const score = scoreCandidate(query, queryWords, nodeName, nodeNote);

            if (score >= FUZZY_SEARCH_THRESHOLD) {
              scoredCandidates.push({ row, score });
            }
          }
        }

        // Sort by score descending (best matches first)
        scoredCandidates.sort((a, b) => b.score - a.score);

        // Take only the requested number of results
        const topResults = scoredCandidates.slice(0, limit);

        // Build results with paths and child previews
        const nodes = topResults.map(({ row, score }) => {
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
            relevance_score: Math.round(score * 100) / 100,
          };
        });

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
  writeMcpLog("Workflowy MCP Server running on stdio", "success");

  // Auto-sync on startup if cache is stale (>24 hours)
  try {
    const apiKey = getApiKey();
    const db = await getDb();

    // Clear any stuck sync_in_progress flag from previous crashed sessions
    const inProgressResult = db.exec(
      "SELECT value FROM sync_meta WHERE key = 'sync_in_progress'",
    );
    if (
      inProgressResult.length > 0 &&
      inProgressResult[0].values[0][0] === "true"
    ) {
      writeMcpLog("Clearing stuck sync_in_progress flag from previous session", "warning");
      db.run(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('sync_in_progress', 'false')",
      );
      saveDb();
    }

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
      writeMcpLog("Cache is stale or empty, starting background sync...", "info");
      // Run sync in background (don't await)
      performFullSync(apiKey, db)
        .then((result) => {
          if (result.success) {
            writeMcpLog(
              `Background sync complete: ${result.nodes_synced} nodes synced`,
              "success"
            );
          } else {
            writeMcpLog(`Background sync failed: ${result.error}`, "error");
          }
        })
        .catch((err) => {
          writeMcpLog(`Background sync error: ${err}`, "error");
        });
    } else {
      writeMcpLog("Cache is fresh, skipping auto-sync", "info");
    }
  } catch (err) {
    // Don't fail startup if auto-sync check fails
    writeMcpLog(`Auto-sync check failed: ${err}`, "error");
  }
}

main().catch((err) => writeMcpLog(`Main error: ${err}`, "error"));
