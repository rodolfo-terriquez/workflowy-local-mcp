export interface StoredAccountConfig {
  id: string;
  name: string;
  apiKey: string;
}

export interface AppConfigWithAccounts {
  apiKey?: string;
  accounts?: Array<Partial<StoredAccountConfig>>;
  defaultAccountId?: string;
}

export type AccountConfigurationSource =
  | "config_file"
  | "environment_variable"
  | "none";

export interface AccountConfigurationIssue {
  code:
    | "CONFIG_ACCOUNT_MISSING_NAME"
    | "CONFIG_ACCOUNT_MISSING_API_KEY"
    | "CONFIG_ACCOUNTS_INVALID"
    | "CONFIG_CHANGED_SINCE_RELOAD"
    | "ENVIRONMENT_ACCOUNTS_INVALID"
    | "ENVIRONMENT_VARIABLE_IGNORED"
    | "NO_VALID_ACCOUNTS";
  severity: "warning" | "error";
  message: string;
  resolution: string;
  accountIndex?: number;
  accountName?: string;
}

export interface ResolvedAccountConfiguration {
  accounts: StoredAccountConfig[];
  defaultAccountId: string | null;
  source: AccountConfigurationSource;
  rawConfigFileAccountCount: number;
  configFileAccountCount: number;
  environmentVariablePresent: boolean;
  environmentAccountCount: number;
  environmentOverrideActive: boolean;
  issues: AccountConfigurationIssue[];
}

const ACCOUNT_ENTRY_SEPARATOR = /[\n;,]/;
const HEX_KEY_PREFIX = /^[0-9a-f-]+$/i;
const ACCOUNT_LABEL = /^[A-Za-z0-9][A-Za-z0-9 .@_+-]{0,29}$/;
const JSON_CONFIG_HINT = /"mcpServers"|"command"|"args"/;
const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,49}$/;

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_LABEL.test(name);
}

export function assertNotJsonConfig(rawValue: string): void {
  const trimmed = rawValue.trim();
  if (
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
    JSON_CONFIG_HINT.test(trimmed)
  ) {
    throw new Error(
      "Workflowy API key configuration appears to contain MCP JSON config. Paste only Workflowy API key values, for example: key1, key2 or Personal: key1, Work: key2.",
    );
  }
}

function parseAccountEntry(
  entry: string,
  generatedIndex: number,
): { name: string; apiKey: string } {
  const colonIdx = entry.indexOf(":");
  const labelCandidate =
    colonIdx > 0 ? entry.substring(0, colonIdx).trim() : "";
  const hasLabel =
    colonIdx > 0 &&
    colonIdx <= 30 &&
    colonIdx < entry.length - 1 &&
    ACCOUNT_LABEL.test(labelCandidate) &&
    !HEX_KEY_PREFIX.test(labelCandidate);

  if (hasLabel) {
    return {
      name: labelCandidate,
      apiKey: entry.substring(colonIdx + 1).trim(),
    };
  }

  return {
    name: generatedIndex === 0 ? "default" : `account_${generatedIndex + 1}`,
    apiKey: entry.trim(),
  };
}

export function sanitizeAccountSlug(name: string, accountNumber: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return slug || `account_${accountNumber}`;
}

export function uniqueAccountSlug(
  name: string,
  accountNumber: number,
  usedSlugs: Set<string>,
): string {
  const baseSlug = sanitizeAccountSlug(name, accountNumber);
  if (!usedSlugs.has(baseSlug)) {
    usedSlugs.add(baseSlug);
    return baseSlug;
  }

  const indexedSlug = `${baseSlug}_${accountNumber}`;
  if (!usedSlugs.has(indexedSlug)) {
    usedSlugs.add(indexedSlug);
    return indexedSlug;
  }

  let suffix = accountNumber + 1;
  while (usedSlugs.has(`${baseSlug}_${suffix}`)) {
    suffix += 1;
  }

  const fallbackSlug = `${baseSlug}_${suffix}`;
  usedSlugs.add(fallbackSlug);
  return fallbackSlug;
}

export function createAccountDraft(
  existingAccounts: StoredAccountConfig[],
): StoredAccountConfig {
  const usedIds = new Set(existingAccounts.map((account) => account.id));
  const usedNames = new Set(
    existingAccounts.map((account) => account.name.trim().toLowerCase()),
  );
  let accountNumber = existingAccounts.length + 1;
  let name = `Account ${accountNumber}`;

  while (usedNames.has(name.toLowerCase())) {
    accountNumber += 1;
    name = `Account ${accountNumber}`;
  }

  const id =
    existingAccounts.length === 0 && !usedIds.has("default")
      ? "default"
      : uniqueAccountSlug(name, accountNumber, usedIds);

  return { id, name, apiKey: "" };
}

export function parseLegacyAccountConfig(rawValue: string): StoredAccountConfig[] {
  assertNotJsonConfig(rawValue);

  const entries = rawValue
    .split(ACCOUNT_ENTRY_SEPARATOR)
    .map((entry: string) => entry.trim())
    .filter(Boolean);

  const accounts: StoredAccountConfig[] = [];
  const accountNames = new Set<string>();
  const usedSlugs = new Set<string>(["default"]);

  for (const entry of entries) {
    const { name, apiKey } = parseAccountEntry(entry, accounts.length);
    if (!name || !apiKey) {
      continue;
    }

    const accountNameKey = name.toLowerCase();
    if (accountNames.has(accountNameKey)) {
      throw new Error(`Duplicate Workflowy account name "${name}". Account names must be unique.`);
    }
    accountNames.add(accountNameKey);

    const id =
      accounts.length === 0
        ? "default"
        : uniqueAccountSlug(name, accounts.length + 1, usedSlugs);

    accounts.push({ id, name, apiKey });
  }

  return accounts;
}

export function normalizeAccountConfigs(config: AppConfigWithAccounts): {
  accounts: StoredAccountConfig[];
  defaultAccountId: string | null;
} {
  if (Array.isArray(config.accounts) && config.accounts.length > 0) {
    const accounts: StoredAccountConfig[] = [];
    const usedNames = new Set<string>();
    const usedIds = new Set<string>();

    for (const rawAccount of config.accounts) {
      const name = String(rawAccount.name ?? "").trim();
      const apiKey = String(rawAccount.apiKey ?? "").trim();
      if (!name || !apiKey) {
        continue;
      }
      if (!isValidAccountName(name)) {
        throw new Error(`Invalid Workflowy account name "${name}".`);
      }

      const nameKey = name.toLowerCase();
      if (usedNames.has(nameKey)) {
        throw new Error(`Duplicate Workflowy account name "${name}". Account names must be unique.`);
      }
      usedNames.add(nameKey);

      const rawId = String(rawAccount.id ?? "").trim().toLowerCase();
      const preferredId =
        rawId && ACCOUNT_ID.test(rawId)
          ? rawId
          : accounts.length === 0
            ? "default"
            : sanitizeAccountSlug(name, accounts.length + 1);
      let id = preferredId;
      if (usedIds.has(id)) {
        id = uniqueAccountSlug(id, accounts.length + 1, usedIds);
      } else {
        usedIds.add(id);
      }

      accounts.push({ id, name, apiKey });
    }

    const configuredDefault =
      typeof config.defaultAccountId === "string" ? config.defaultAccountId : "";
    const defaultAccountId = accounts.some((account) => account.id === configuredDefault)
      ? configuredDefault
      : accounts[0]?.id ?? null;

    return { accounts, defaultAccountId };
  }

  if (typeof config.apiKey === "string" && config.apiKey.trim()) {
    return {
      accounts: [{ id: "default", name: "default", apiKey: config.apiKey.trim() }],
      defaultAccountId: "default",
    };
  }

  return { accounts: [], defaultAccountId: null };
}

export function resolveAccountConfiguration(
  config: AppConfigWithAccounts,
  environmentValue = "",
): ResolvedAccountConfiguration {
  const issues: AccountConfigurationIssue[] = [];
  const rawAccountsValue = (config as { accounts?: unknown }).accounts;
  const rawAccounts = Array.isArray(rawAccountsValue) ? rawAccountsValue : [];

  if (rawAccountsValue !== undefined && !Array.isArray(rawAccountsValue)) {
    issues.push({
      code: "CONFIG_ACCOUNTS_INVALID",
      severity: "error",
      message: "The accounts field in config.json is not an array.",
      resolution:
        "Open Workflowy MCP Accounts settings and save again to replace the malformed configuration.",
    });
  }

  rawAccounts.forEach((account, index) => {
    const name = String(account.name ?? "").trim();
    const apiKey = String(account.apiKey ?? "").trim();
    if (!name) {
      issues.push({
        code: "CONFIG_ACCOUNT_MISSING_NAME",
        severity: "error",
        message: `Account entry ${index + 1} in config.json has no nickname.`,
        resolution: "Add a unique account nickname in the Workflowy MCP Accounts settings.",
        accountIndex: index,
      });
    }
    if (!apiKey) {
      issues.push({
        code: "CONFIG_ACCOUNT_MISSING_API_KEY",
        severity: "error",
        message: name
          ? `Account \"${name}\" in config.json has no API key.`
          : `Account entry ${index + 1} in config.json has no API key.`,
        resolution: "Add the account API key in the Workflowy MCP Accounts settings and save again.",
        accountIndex: index,
        ...(name ? { accountName: name } : {}),
      });
    }
  });

  let fileAccounts: StoredAccountConfig[] = [];
  let fileDefaultAccountId: string | null = null;
  try {
    const normalized = normalizeAccountConfigs(config);
    fileAccounts = normalized.accounts;
    fileDefaultAccountId = normalized.defaultAccountId;
  } catch (error) {
    issues.push({
      code: "CONFIG_ACCOUNTS_INVALID",
      severity: "error",
      message: `The accounts in config.json are invalid: ${error instanceof Error ? error.message : String(error)}`,
      resolution: "Correct the account nicknames and IDs in Workflowy MCP, then save the Accounts settings again.",
    });
  }

  const trimmedEnvironmentValue = environmentValue.trim();
  let environmentAccounts: StoredAccountConfig[] = [];
  if (trimmedEnvironmentValue) {
    try {
      environmentAccounts = parseLegacyAccountConfig(trimmedEnvironmentValue);
    } catch (error) {
      issues.push({
        code: "ENVIRONMENT_ACCOUNTS_INVALID",
        severity: "error",
        message: `WORKFLOWY_API_KEY could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
        resolution: "Remove WORKFLOWY_API_KEY from the MCP launch configuration or correct its labeled account entries.",
      });
    }
  }

  const hasStructuredFileAccounts = rawAccounts.length > 0 && fileAccounts.length > 0;
  if (hasStructuredFileAccounts) {
    if (trimmedEnvironmentValue) {
      issues.push({
        code: "ENVIRONMENT_VARIABLE_IGNORED",
        severity: "warning",
        message:
          "WORKFLOWY_API_KEY is defined, but structured accounts from config.json take precedence.",
        resolution:
          "Remove WORKFLOWY_API_KEY from the MCP launch configuration to avoid ambiguous account settings.",
      });
    }
    return {
      accounts: fileAccounts,
      defaultAccountId: fileDefaultAccountId,
      source: "config_file",
      rawConfigFileAccountCount: rawAccounts.length,
      configFileAccountCount: fileAccounts.length,
      environmentVariablePresent: Boolean(trimmedEnvironmentValue),
      environmentAccountCount: environmentAccounts.length,
      environmentOverrideActive: false,
      issues,
    };
  }

  if (environmentAccounts.length > 0) {
    return {
      accounts: environmentAccounts,
      defaultAccountId: environmentAccounts[0]?.id ?? null,
      source: "environment_variable",
      rawConfigFileAccountCount: rawAccounts.length,
      configFileAccountCount: fileAccounts.length,
      environmentVariablePresent: true,
      environmentAccountCount: environmentAccounts.length,
      environmentOverrideActive: true,
      issues,
    };
  }

  if (fileAccounts.length > 0) {
    return {
      accounts: fileAccounts,
      defaultAccountId: fileDefaultAccountId,
      source: "config_file",
      rawConfigFileAccountCount: rawAccounts.length,
      configFileAccountCount: fileAccounts.length,
      environmentVariablePresent: Boolean(trimmedEnvironmentValue),
      environmentAccountCount: environmentAccounts.length,
      environmentOverrideActive: false,
      issues,
    };
  }

  issues.push({
    code: "NO_VALID_ACCOUNTS",
    severity: "error",
    message: "No valid Workflowy accounts were found in config.json or WORKFLOWY_API_KEY.",
    resolution:
      "Add and save an account in Workflowy MCP, then call reload_configuration.",
  });

  return {
    accounts: [],
    defaultAccountId: null,
    source: "none",
    rawConfigFileAccountCount: rawAccounts.length,
    configFileAccountCount: 0,
    environmentVariablePresent: Boolean(trimmedEnvironmentValue),
    environmentAccountCount: environmentAccounts.length,
    environmentOverrideActive: false,
    issues,
  };
}
