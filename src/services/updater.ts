import { check } from "@tauri-apps/plugin-updater";

const SKIPPED_VERSION_KEY = "workflowy-mcp.skippedUpdateVersion";

let hasCheckedThisRun = false;

type AppUpdateCheckStatus =
  | "disabled"
  | "up-to-date"
  | "skipped"
  | "declined"
  | "installed"
  | "error";

export interface AppUpdateCheckResult {
  status: AppUpdateCheckStatus;
  version?: string;
  message?: string;
}

type AppUpdateAvailabilityStatus = "disabled" | "available" | "up-to-date" | "error";

export interface AppUpdateAvailabilityResult {
  status: AppUpdateAvailabilityStatus;
  version?: string;
  message?: string;
}

interface RunAppUpdateCheckOptions {
  respectSkippedVersion?: boolean;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return "Unknown updater error";
}

async function runAppUpdateCheck(
  { respectSkippedVersion = true }: RunAppUpdateCheckOptions = {}
): Promise<AppUpdateCheckResult> {
  if (import.meta.env.DEV) {
    return { status: "disabled", message: "Updater is disabled in development builds." };
  }

  let update: Awaited<ReturnType<typeof check>> = null;

  try {
    update = await check();
    if (!update) return { status: "up-to-date" };

    if (respectSkippedVersion) {
      const skippedVersion = localStorage.getItem(SKIPPED_VERSION_KEY);
      if (skippedVersion === update.version) {
        return { status: "skipped", version: update.version };
      }
    }

    const shouldInstall = confirm(
      `A new update is available (v${update.version}).\n\nInstall it now? The app will restart after installing.`
    );

    if (!shouldInstall) {
      localStorage.setItem(SKIPPED_VERSION_KEY, update.version);
      return { status: "declined", version: update.version };
    }

    await update.downloadAndInstall();
    localStorage.removeItem(SKIPPED_VERSION_KEY);

    alert("Update installed. Please restart the app to finish applying it.");
    return { status: "installed", version: update.version };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("[updater] Failed to check for updates:", error);
    return { status: "error", message };
  } finally {
    if (update) {
      await update.close().catch(() => {});
    }
  }
}

export async function checkForAppUpdatesOnLaunch(): Promise<void> {
  if (hasCheckedThisRun || import.meta.env.DEV) return;
  hasCheckedThisRun = true;

  await runAppUpdateCheck({ respectSkippedVersion: true });
}

export async function checkForAppUpdatesManually(): Promise<AppUpdateCheckResult> {
  return runAppUpdateCheck({ respectSkippedVersion: false });
}

export async function getAvailableAppUpdate(): Promise<AppUpdateAvailabilityResult> {
  if (import.meta.env.DEV) {
    return { status: "disabled", message: "Updater is disabled in development builds." };
  }

  let update: Awaited<ReturnType<typeof check>> = null;

  try {
    update = await check();
    if (!update) return { status: "up-to-date" };

    return { status: "available", version: update.version };
  } catch (error) {
    const message = getErrorMessage(error);
    console.error("[updater] Failed to probe for updates:", error);
    return { status: "error", message };
  } finally {
    if (update) {
      await update.close().catch(() => {});
    }
  }
}
