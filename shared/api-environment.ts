export type WorkflowyApiEnvironment = "production" | "beta";

export const DEFAULT_API_ENVIRONMENT: WorkflowyApiEnvironment = "production";

const API_BASE_URLS: Record<WorkflowyApiEnvironment, string> = {
  production: "https://workflowy.com/api/v1",
  beta: "https://beta.workflowy.com/api/v1",
};

export function normalizeApiEnvironment(
  value: unknown,
): WorkflowyApiEnvironment {
  if (typeof value !== "string") {
    return DEFAULT_API_ENVIRONMENT;
  }

  switch (value.trim().toLowerCase()) {
    case "beta":
      return "beta";
    case "production":
    case "prod":
    default:
      return DEFAULT_API_ENVIRONMENT;
  }
}

export function resolveApiEnvironment(
  configValue?: unknown,
  environmentValue?: unknown,
): WorkflowyApiEnvironment {
  if (typeof environmentValue === "string" && environmentValue.trim()) {
    return normalizeApiEnvironment(environmentValue);
  }
  return normalizeApiEnvironment(configValue);
}

export function getPublicApiBaseUrl(
  environment: WorkflowyApiEnvironment,
): string {
  return API_BASE_URLS[environment];
}

export function getPublicApiUrl(
  environment: WorkflowyApiEnvironment,
  path: string,
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${getPublicApiBaseUrl(environment)}${normalizedPath}`;
}

export function getEnvironmentDataDirName(
  environment: WorkflowyApiEnvironment,
): string | null {
  return environment === "production" ? null : environment;
}
