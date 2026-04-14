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
