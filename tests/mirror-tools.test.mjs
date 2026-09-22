import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import initSqlJs from "sql.js/dist/sql-asm.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function getTestDataDir(testHome) {
  if (process.platform === "darwin") {
    return path.join(testHome, "Library", "Application Support", "com.workflowy.local-mcp");
  }
  if (process.platform === "win32") {
    return path.join(testHome, "com.workflowy.local-mcp");
  }
  return path.join(testHome, ".local", "share", "com.workflowy.local-mcp");
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function seedLegacyCache(dataDir) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      note TEXT,
      parent_id TEXT,
      completed INTEGER DEFAULT 0,
      children_count INTEGER DEFAULT 0,
      priority INTEGER DEFAULT 0,
      created_at TEXT,
      updated_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.run(
    "INSERT INTO nodes (id, name, parent_id, children_count) VALUES (?, ?, ?, ?)",
    ["parent-1", "Destination", null, 0],
  );
  db.run(
    "INSERT INTO nodes (id, name, parent_id, children_count) VALUES (?, ?, ?, ?)",
    ["origin-1", "Origin", null, 0],
  );
  db.run("INSERT INTO sync_meta (key, value) VALUES (?, ?)", [
    "last_full_sync",
    new Date().toISOString(),
  ]);
  db.run("INSERT INTO sync_meta (key, value) VALUES (?, ?)", [
    "public_api_environment",
    "production",
  ]);
  db.run("INSERT INTO sync_meta (key, value) VALUES (?, ?)", [
    "last_backup_date",
    getLocalDateKey(),
  ]);
  fs.writeFileSync(path.join(dataDir, "bookmarks.db"), Buffer.from(db.export()));
  db.close();
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

test("production mirror writes refresh and invalidate a migrated cache", { timeout: 20_000 }, async () => {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "workflowy-mirror-tools-"));
  const dataDir = getTestDataDir(testHome);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      accounts: [{ id: "default", name: "default", apiKey: "synthetic-test-key" }],
      defaultAccountId: "default",
      apiEnvironment: "production",
    }),
  );
  await seedLegacyCache(dataDir);

  const mockImport = pathToFileURL(path.resolve("tests/mock-workflowy-fetch.mjs")).href;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.cjs")],
    cwd: process.cwd(),
    env: {
      APPDATA: testHome,
      HOME: testHome,
      NODE_OPTIONS: `--import=${mockImport}`,
      PATH: process.env.PATH ?? "",
      USERPROFILE: testHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mirror-tools-test", version: "1.0.0" });

  try {
    await client.connect(transport);

    await assert.rejects(
      client.callTool({ name: "mirror_info", arguments: { node_id: "mirror-1" } }),
      /requires the beta public API/,
    );

    const created = parseToolResult(await client.callTool({
      name: "create_mirror",
      arguments: { node_id: "origin-1", parent_id: "parent-1", position: "bottom" },
    }));
    assert.equal(created.ok, true);
    assert.equal(created.api_environment, "production");
    assert.equal(created.cache_refreshed, true);

    const afterCreate = parseToolResult(await client.callTool({
      name: "search_nodes",
      arguments: { query: "Shared mirror item", include_completed: true },
    }));
    assert.equal(afterCreate.results.length, 1);
    assert.deepEqual(afterCreate.results[0].mirror, {
      role: "mirror",
      origin_id: null,
      mirror_ids: [],
    });

    const removed = parseToolResult(await client.callTool({
      name: "remove_mirror",
      arguments: { node_id: "mirror-1", confirm: true },
    }));
    assert.equal(removed.ok, true);
    assert.equal(removed.origin_preserved, true);
    assert.equal(removed.origin_id, null);
    assert.equal(removed.cache_refreshed, true);

    const afterRemove = parseToolResult(await client.callTool({
      name: "search_nodes",
      arguments: { query: "Shared mirror item", include_completed: true },
    }));
    assert.deepEqual(afterRemove.results, []);
  } finally {
    await client.close();
  }

  const SQL = await initSqlJs();
  const migrated = new SQL.Database(fs.readFileSync(path.join(dataDir, "bookmarks.db")));
  const columns = migrated.exec("PRAGMA table_info(nodes)")[0].values.map((row) => row[1]);
  assert.ok(columns.includes("mirror_role"));
  assert.ok(columns.includes("mirror_origin_id"));
  assert.ok(columns.includes("mirror_ids"));
  migrated.close();
  fs.rmSync(testHome, { recursive: true, force: true });
});
