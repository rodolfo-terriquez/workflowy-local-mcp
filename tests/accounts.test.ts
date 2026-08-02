import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountDraft,
  normalizeAccountConfigs,
  parseLegacyAccountConfig,
  resolveAccountConfiguration,
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

test("five structured accounts are preserved", () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({
    id: index === 0 ? "default" : `account_${index + 1}`,
    name: `Account ${index + 1}`,
    apiKey: `key${index + 1}`,
  }));

  assert.deepEqual(normalizeAccountConfigs({ accounts }).accounts, accounts);
});

test("new account drafts remain unique after a middle account is removed", () => {
  const accounts = Array.from({ length: 5 }, (_, index) => ({
    id: index === 0 ? "default" : `account_${index + 1}`,
    name: `Account ${index + 1}`,
    apiKey: `key${index + 1}`,
  }));
  const remaining = accounts.filter((account) => account.id !== "account_3");

  assert.deepEqual(createAccountDraft(remaining), {
    id: "account_6",
    name: "Account 6",
    apiKey: "",
  });
});

test("structured file accounts take precedence over legacy environment accounts", () => {
  const resolved = resolveAccountConfiguration(
    {
      accounts: [
        { id: "default", name: "Main", apiKey: "key1" },
        { id: "priority", name: "WF Priority", apiKey: "key2" },
      ],
      defaultAccountId: "priority",
    },
    "Main: env-key1, Work: env-key2",
  );

  assert.equal(resolved.source, "config_file");
  assert.equal(resolved.accounts.length, 2);
  assert.equal(resolved.defaultAccountId, "priority");
  assert.equal(resolved.environmentVariablePresent, true);
  assert.equal(resolved.environmentOverrideActive, false);
  assert.equal(resolved.environmentAccountCount, 2);
  assert.ok(
    resolved.issues.some((issue) => issue.code === "ENVIRONMENT_VARIABLE_IGNORED"),
  );
});

test("legacy environment accounts remain a fallback when the file has no accounts", () => {
  const resolved = resolveAccountConfiguration({}, "Main: key1, Work: key2");

  assert.equal(resolved.source, "environment_variable");
  assert.equal(resolved.accounts.length, 2);
  assert.equal(resolved.environmentOverrideActive, true);
});

test("incomplete file accounts produce sanitized diagnostics", () => {
  const resolved = resolveAccountConfiguration({
    accounts: [
      { id: "default", name: "Main", apiKey: "key1" },
      { id: "priority", name: "WF Priority", apiKey: "" },
    ],
  });

  assert.equal(resolved.rawConfigFileAccountCount, 2);
  assert.equal(resolved.configFileAccountCount, 1);
  assert.equal(resolved.accounts.length, 1);
  assert.ok(
    resolved.issues.some(
      (issue) =>
        issue.code === "CONFIG_ACCOUNT_MISSING_API_KEY" &&
        issue.accountName === "WF Priority",
    ),
  );
  assert.equal(JSON.stringify(resolved.issues).includes("key1"), false);
});

test("missing accounts include a remediation issue", () => {
  const resolved = resolveAccountConfiguration({});

  assert.equal(resolved.source, "none");
  assert.ok(
    resolved.issues.some((issue) => issue.code === "NO_VALID_ACCOUNTS"),
  );
});

test("reports a malformed config accounts field without exposing its value", () => {
  const resolved = resolveAccountConfiguration(
    { accounts: "secret-malformed-value" } as never,
    "",
  );

  assert.ok(
    resolved.issues.some(
      (issue) =>
        issue.code === "CONFIG_ACCOUNTS_INVALID" &&
        issue.message === "The accounts field in config.json is not an array.",
    ),
  );
  assert.equal(JSON.stringify(resolved.issues).includes("secret-malformed-value"), false);
});
