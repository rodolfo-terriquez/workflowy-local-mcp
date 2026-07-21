import test from "node:test";
import assert from "node:assert/strict";
import {
  getEnvironmentDataDirName,
  getPublicApiBaseUrl,
  getPublicApiUrl,
  normalizeApiEnvironment,
  resolveApiEnvironment,
} from "../shared/api-environment.js";

test("production remains the default", () => {
  assert.equal(normalizeApiEnvironment(undefined), "production");
  assert.equal(normalizeApiEnvironment("invalid"), "production");
  assert.equal(normalizeApiEnvironment("prod"), "production");
});

test("beta can be selected explicitly", () => {
  assert.equal(normalizeApiEnvironment(" BETA "), "beta");
  assert.equal(getPublicApiBaseUrl("beta"), "https://beta.workflowy.com/api/v1");
  assert.equal(
    getPublicApiUrl("beta", "/nodes-export"),
    "https://beta.workflowy.com/api/v1/nodes-export",
  );
});

test("environment variable takes precedence over saved config", () => {
  assert.equal(resolveApiEnvironment("production", "beta"), "beta");
  assert.equal(resolveApiEnvironment("beta", "production"), "production");
});

test("only beta uses an environment-specific data directory", () => {
  assert.equal(getEnvironmentDataDirName("production"), null);
  assert.equal(getEnvironmentDataDirName("beta"), "beta");
});
