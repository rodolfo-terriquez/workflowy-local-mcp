import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function getTestDataDir(testHome) {
  if (process.platform === "darwin") {
    return path.join(
      testHome,
      "Library",
      "Application Support",
      "com.workflowy.local-mcp",
    );
  }
  if (process.platform === "win32") {
    return path.join(testHome, "com.workflowy.local-mcp");
  }
  return path.join(testHome, ".local", "share", "com.workflowy.local-mcp");
}

test("running MCP server hot-reloads a fifth account and its tool schemas", { timeout: 15_000 }, async () => {
  const testHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflowy-mcp-hot-reload-"),
  );
  const dataDir = getTestDataDir(testHome);
  const configPath = path.join(dataDir, "config.json");
  fs.mkdirSync(dataDir, { recursive: true });

  const writeAccounts = (count) => {
    const accounts = Array.from({ length: count }, (_, index) => ({
      id: index === 0 ? "default" : `account_${index + 1}`,
      name: index === 4 ? "WF Priority" : `Account ${index + 1}`,
      apiKey: `invalid-test-key-${index + 1}`,
    }));
    fs.writeFileSync(
      configPath,
      JSON.stringify({ accounts, defaultAccountId: accounts[0].id }, null, 2),
    );
  };

  writeAccounts(4);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.cjs")],
    cwd: process.cwd(),
    env: {
      APPDATA: testHome,
      HOME: testHome,
      PATH: process.env.PATH ?? "",
      USERPROFILE: testHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "hot-reload-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const initial = await client.callTool({
      name: "list_accounts",
      arguments: {},
    });
    const initialPayload = JSON.parse(initial.content[0].text);
    assert.equal(initialPayload.account_count, 4);

    writeAccounts(5);
    const reloaded = await client.callTool({
      name: "list_accounts",
      arguments: {},
    });
    const reloadedPayload = JSON.parse(reloaded.content[0].text);
    assert.equal(reloadedPayload.account_count, 5);
    assert.ok(
      reloadedPayload.accounts.some(
        (account) => account.name === "WF Priority",
      ),
    );
    assert.equal(
      reloadedPayload.configuration.config_changed_since_last_reload,
      false,
    );

    const tools = await client.listTools();
    const syncTool = tools.tools.find((tool) => tool.name === "sync_nodes");
    const accountEnum = syncTool?.inputSchema?.properties?.account?.enum ?? [];
    assert.ok(accountEnum.includes("WF Priority"));
    assert.ok(
      tools.tools.some((tool) => tool.name === "reload_configuration"),
    );
  } finally {
    await client.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

test("MCP server starts without accounts and returns actionable diagnostics", { timeout: 15_000 }, async () => {
  const testHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "workflowy-mcp-no-accounts-"),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.cjs")],
    cwd: process.cwd(),
    env: {
      APPDATA: testHome,
      HOME: testHome,
      PATH: process.env.PATH ?? "",
      USERPROFILE: testHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "no-accounts-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "list_accounts",
      arguments: {},
    });
    const payload = JSON.parse(response.content[0].text);
    assert.equal(payload.account_count, 0);
    assert.equal(payload.configuration.configuration_source, "none");
    assert.ok(
      payload.configuration.issues.some(
        (issue) => issue.code === "NO_VALID_ACCOUNTS",
      ),
    );

    const prompt = await client.getPrompt({ name: "server_instructions" });
    assert.match(prompt.messages[0].content.text, /No valid Workflowy accounts/);
  } finally {
    await client.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});
