import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const SKIPPED_VERSION_KEY = "workflowy-mcp.skippedUpdateVersion";

let hasCheckedThisRun = false;

type AppUpdateCheckStatus =
  | "disabled"
  | "up-to-date"
  | "skipped"
  | "installed"
  | "error";

export interface AppUpdateCheckResult {
  status: AppUpdateCheckStatus;
  version?: string;
  message?: string;
}

export type UpdateProgressPhase = "downloading" | "installing";

export interface UpdateProgress {
  phase: UpdateProgressPhase;
  contentLength?: number;
  downloaded?: number;
}

type AppUpdateAvailabilityStatus = "disabled" | "available" | "up-to-date" | "error";

export interface AppUpdateAvailabilityResult {
  status: AppUpdateAvailabilityStatus;
  version?: string;
  message?: string;
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

async function silentCheckOnLaunch(): Promise<void> {
  if (import.meta.env.DEV) return;

  let update: Awaited<ReturnType<typeof check>> = null;

  try {
    update = await check();
    if (!update) return;

    const skippedVersion = localStorage.getItem(SKIPPED_VERSION_KEY);
    if (skippedVersion === update.version) return;
  } catch (error) {
    console.log("[updater] Launch check failed:", error);
  } finally {
    if (update) {
      await update.close().catch(() => {});
    }
  }
}

export async function installUpdate(
  onProgress?: (progress: UpdateProgress) => void,
): Promise<AppUpdateCheckResult> {
  if (import.meta.env.DEV) {
    return { status: "disabled", message: "Updater is disabled in development builds." };
  }

  let update: Awaited<ReturnType<typeof check>> = null;
  let downloaded = 0;
  let contentLength: number | undefined;

  try {
    update = await check();
    if (!update) return { status: "up-to-date" };

    await update.download((event: DownloadEvent) => {
      switch (event.event) {
        case "Started":
          contentLength = event.data.contentLength ?? undefined;
          downloaded = 0;
          onProgress?.({ phase: "downloading", contentLength, downloaded: 0 });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onProgress?.({ phase: "downloading", contentLength, downloaded });
          break;
        case "Finished":
          onProgress?.({ phase: "installing" });
          break;
      }
    });

    await update.install();
    localStorage.removeItem(SKIPPED_VERSION_KEY);

    await relaunch();
    return { status: "installed", version: update.version };
  } catch (error) {
    const msg = getErrorMessage(error);
    const phase = downloaded > 0 && contentLength && downloaded >= contentLength
      ? "install" : "download";
    console.error(`[updater] Failed during ${phase}:`, error);
    return { status: "error", message: `${phase === "install" ? "Install" : "Download"} failed: ${msg}` };
  } finally {
    if (update) {
      await update.close().catch(() => {});
    }
  }
}

export async function checkForAppUpdatesOnLaunch(): Promise<void> {
  if (hasCheckedThisRun || import.meta.env.DEV) return;
  hasCheckedThisRun = true;

  await silentCheckOnLaunch();
}

export function skipVersion(version: string): void {
  localStorage.setItem(SKIPPED_VERSION_KEY, version);
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
