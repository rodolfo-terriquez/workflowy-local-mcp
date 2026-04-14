import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAccountConfigs,
  parseLegacyAccountConfig,
} from "../shared/accounts.js";

test("single bare legacy key uses default account id", () => {
  assert.deepEqual(parseLegacyAccountConfig("key1"), [
    { id: "default", name: "default", apiKey: "key1" },
  ]);
});

test("single labeled legacy key keeps default account id", () => {
  assert.deepEqual(parseLegacyAccountConfig("Personal: key1"), [
    { id: "default", name: "Personal", apiKey: "key1" },
  ]);
});

test("multiple labeled legacy keys get isolated stable ids", () => {
  assert.deepEqual(parseLegacyAccountConfig("Personal: key1, Work: key2, Client: key3"), [
    { id: "default", name: "Personal", apiKey: "key1" },
    { id: "work", name: "Work", apiKey: "key2" },
    { id: "client", name: "Client", apiKey: "key3" },
  ]);
});

test("duplicate legacy account names are rejected case-insensitively", () => {
  assert.throws(
    () => parseLegacyAccountConfig("Work: key1, work: key2"),
    /Duplicate Workflowy account name "work"/,
  );
});

test("legacy labels with colliding slugs get distinct ids", () => {
  assert.deepEqual(parseLegacyAccountConfig("Primary: key1, A B: key2, A@B: key3"), [
    { id: "default", name: "Primary", apiKey: "key1" },
    { id: "a_b", name: "A B", apiKey: "key2" },
    { id: "a_b_3", name: "A@B", apiKey: "key3" },
  ]);
});

test("MCP JSON config is rejected instead of parsed as account labels", () => {
  const jsonConfig = `{
    "mcpServers": {
      "workflowy": {
        "command": "node",
        "args": ["/tmp/server/index.js"]
      }
    }
  }`;

  assert.throws(
    () => parseLegacyAccountConfig(jsonConfig),
    /appears to contain MCP JSON config/,
  );
});

test("structured config preserves ids and default account", () => {
  assert.deepEqual(
    normalizeAccountConfigs({
      accounts: [
        { id: "default", name: "Personal", apiKey: "key1" },
        { id: "work", name: "Work", apiKey: "key2" },
      ],
      defaultAccountId: "work",
    }),
    {
      accounts: [
        { id: "default", name: "Personal", apiKey: "key1" },
        { id: "work", name: "Work", apiKey: "key2" },
      ],
      defaultAccountId: "work",
    },
  );
});

test("structured config falls back to first account for missing default", () => {
  assert.deepEqual(
    normalizeAccountConfigs({
      accounts: [
        { id: "default", name: "Personal", apiKey: "key1" },
        { id: "work", name: "Work", apiKey: "key2" },
      ],
      defaultAccountId: "missing",
    }).defaultAccountId,
    "default",
  );
});

test("legacy apiKey config normalizes to default account", () => {
  assert.deepEqual(normalizeAccountConfigs({ apiKey: "key1" }), {
    accounts: [{ id: "default", name: "default", apiKey: "key1" }],
    defaultAccountId: "default",
  });
});
