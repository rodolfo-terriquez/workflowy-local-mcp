import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";
import { defaultServerInstructions, defaultTools } from "../shared/constants";

// Current app version - update this when releasing new versions
const APP_VERSION = "1.2.1";
const GITHUB_REPO = "rodolfo-terriquez/workflowy-local-mcp";

interface LogEntry {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
  timestamp: Date;
  source: "app" | "mcp";
}

interface McpLogEntry {
  timestamp: string;
  message: string;
  log_type: string;
  source: string;
}

interface Bookmark {
  name: string;
  node_id: string;
  context: string | null;
  created_at: string | null;
}

// Default server instructions and tool definitions are imported from shared/constants.ts

interface CacheStatus {
  cache_populated: boolean;
  node_count: number;
  last_sync: string;
  hours_since_sync: number | null;
  is_stale: boolean;
  can_sync_now: boolean;
  sync_cooldown_seconds: number;
}

function App() {
  const [apiKey, setApiKey] = useState("");
  const [savedApiKey, setSavedApiKey] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [activeTab, setActiveTab] = useState<
    "claude-code" | "claude-desktop" | "cursor"
  >("claude-code");
  const [activeSection, setActiveSection] = useState<
    "general" | "api-key" | "tools" | "setup" | "bookmarks" | "cache"
  >("api-key");

  // Tool customization state
  const [serverDescription, setServerDescription] = useState("");
  const [toolDescriptions, setToolDescriptions] = useState<
    Record<string, string>
  >({});
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [serverPath, setServerPath] = useState("");

  // Bookmarks state
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<string | null>(null);
  const [editingContext, setEditingContext] = useState<string>("");

  // Cache state
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncCooldown, setSyncCooldown] = useState(0);

  // MCP logs state
  const [mcpLogs, setMcpLogs] = useState<LogEntry[]>([]);

  // Update check state
  const [updateAvailable, setUpdateAvailable] = useState<{
    version: string;
    url: string;
  } | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    loadConfig();
    loadServerPath();
    checkForUpdates();
  }, []);

  // Countdown timer for sync cooldown
  useEffect(() => {
    if (syncCooldown > 0) {
      const timer = setTimeout(() => setSyncCooldown(syncCooldown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [syncCooldown]);

  // Load cache status when cache section is active
  useEffect(() => {
    if (activeSection === "cache" && savedApiKey) {
      loadCacheStatus();
    }
  }, [activeSection, savedApiKey]);

  // Load MCP logs when logs section is active
  useEffect(() => {
    if (activeSection === "general") {
      loadMcpLogs();
    }
  }, [activeSection]);

  // Auto-refresh logs while on logs tab
  useEffect(() => {
    if (activeSection === "general") {
      const interval = setInterval(() => {
        loadMcpLogs();
      }, 3000); // Refresh every 3 seconds
      return () => clearInterval(interval);
    }
  }, [activeSection]);

  const loadCacheStatus = async () => {
    if (!savedApiKey) return;

    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const response = await fetch("https://workflowy.com/api/v1/targets", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${savedApiKey}`,
        },
      });

      if (!response.ok) {
        addLog("Failed to validate API key for cache status", "error");
        return;
      }

      // Read cache status from the database file
      const dataDir = await getDataDir();
      const { readFile, exists } = await import("@tauri-apps/plugin-fs");
      const dbPath = dataDir + "/bookmarks.db";

      if (await exists(dbPath)) {
        // We can't directly query SQLite from the UI, so we'll show basic info
        // The actual status comes from the MCP server's get_cache_status tool
        // For now, show that the database exists
        const dbData = await readFile(dbPath);
        if (dbData.byteLength > 0) {
          // Database exists and has data - show a placeholder status
          // Real status would require the MCP server to be running
          setCacheStatus({
            cache_populated: true,
            node_count: -1, // Unknown from UI
            last_sync: "Check via MCP tools",
            hours_since_sync: null,
            is_stale: false,
            can_sync_now: true,
            sync_cooldown_seconds: 0,
          });
        }
      } else {
        setCacheStatus({
          cache_populated: false,
          node_count: 0,
          last_sync: "never",
          hours_since_sync: null,
          is_stale: true,
          can_sync_now: true,
          sync_cooldown_seconds: 0,
        });
      }
    } catch (e) {
      console.error("Failed to load cache status:", e);
      addLog(`Failed to load cache status: ${e}`, "error");
    }
  };

  const loadMcpLogs = async () => {
    try {
      const result = await invoke<McpLogEntry[]>("get_mcp_logs");
      const convertedLogs: LogEntry[] = result.map((entry, index) => ({
        id: new Date(entry.timestamp).getTime() + index,
        message: entry.message,
        type: entry.log_type as LogEntry["type"],
        timestamp: new Date(entry.timestamp),
        source: "mcp" as const,
      }));
      setMcpLogs(convertedLogs);
    } catch (e) {
      console.error("Failed to load MCP logs:", e);
    }
  };

  const checkForUpdates = async () => {
    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const response = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          method: "GET",
          headers: {
            Accept: "application/vnd.github.v3+json",
          },
        }
      );

      if (!response.ok) {
        console.log("Could not check for updates:", response.status);
        return;
      }

      const release = await response.json();
      const latestVersion = release.tag_name?.replace(/^v/, "") || "";
      
      // Compare versions (simple string comparison works for semver)
      if (latestVersion && compareVersions(latestVersion, APP_VERSION) > 0) {
        setUpdateAvailable({
          version: latestVersion,
          url: release.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
        });
      }
    } catch (e) {
      // Silently fail - update check is not critical
      console.log("Update check failed:", e);
    }
  };

  // Compare semver versions: returns 1 if a > b, -1 if a < b, 0 if equal
  const compareVersions = (a: string, b: string): number => {
    const partsA = a.split(".").map(Number);
    const partsB = b.split(".").map(Number);
    
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const numA = partsA[i] || 0;
      const numB = partsB[i] || 0;
      if (numA > numB) return 1;
      if (numA < numB) return -1;
    }
    return 0;
  };

  const openReleasePage = async () => {
    if (updateAvailable?.url) {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(updateAvailable.url);
    }
  };

  const clearAllLogs = async () => {
    // Clear app logs
    setLogs([]);
    // Clear MCP logs (both state and file)
    setMcpLogs([]);
    try {
      await invoke("clear_mcp_logs");
    } catch (e) {
      console.error("Failed to clear MCP logs:", e);
    }
  };

  const syncNow = async () => {
    if (!savedApiKey || isSyncing) return;

    setIsSyncing(true);
    addLog("Starting node sync...", "info");

    try {
      const { fetch } = await import("@tauri-apps/plugin-http");
      const response = await fetch(
        "https://workflowy.com/api/v1/nodes-export",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${savedApiKey}`,
            "Content-Type": "application/json",
          },
        },
      );

      const data = await response.json();
      
      // Check for rate limit error
      if (data.error) {
        const retryAfter = data.retry_after || 60;
        addLog(`API rate limited. Retry after ${retryAfter} seconds.`, "error");
        showToast(`Rate limited. Wait ${retryAfter}s and try again.`, "error");
        setSyncCooldown(retryAfter);
        return;
      }

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      // API returns { nodes: [...] }, not just an array
      const nodes = data.nodes || [];
      const nodeCount = Array.isArray(nodes) ? nodes.length : 0;

      addLog(`Sync complete: ${nodeCount} nodes fetched`, "success");
      showToast(`Synced ${nodeCount} nodes successfully`, "success");

      // Update status
      setCacheStatus({
        cache_populated: true,
        node_count: nodeCount,
        last_sync: new Date().toISOString(),
        hours_since_sync: 0,
        is_stale: false,
        can_sync_now: false,
        sync_cooldown_seconds: 60,
      });

      // Start cooldown
      setSyncCooldown(60);

      // Note: The actual database update happens via the MCP server
      // This UI sync just fetches and displays info - the MCP server handles persistence
      showToast(
        "Nodes fetched! Use sync_nodes via MCP for persistent cache.",
        "success",
      );
    } catch (e) {
      addLog(`Sync failed: ${e}`, "error");
      showToast("Sync failed. Check logs for details.", "error");
    } finally {
      setIsSyncing(false);
    }
  };

  const loadConfig = async () => {
    try {
      const dataDir = await getDataDir();
      const configPath = dataDir + "/config.json";

      const { readTextFile, exists } = await import("@tauri-apps/plugin-fs");
      if (await exists(configPath)) {
        const content = await readTextFile(configPath);
        const config = JSON.parse(content);
        if (config.apiKey) {
          setSavedApiKey(config.apiKey);
          setApiKey(config.apiKey);
          addLog("API key loaded from config", "success");
        }
        if (config.serverDescription) {
          setServerDescription(config.serverDescription);
        }
        if (config.toolDescriptions) {
          setToolDescriptions(config.toolDescriptions);
        }
      }
    } catch (e) {
      console.error("Error loading config:", e);
    }
  };

  const loadServerPath = async () => {
    try {
      const path = await invoke<string>("get_server_path");
      setServerPath(path);
    } catch (e) {
      console.error("Failed to get server path", e);
    }
  };

  const getDataDir = async (): Promise<string> => {
    try {
      const { appDataDir } = await import("@tauri-apps/api/path");
      return await appDataDir();
    } catch (e) {
      console.error("Failed to get data dir", e);
      return "";
    }
  };

  const saveConfig = async (config: Record<string, unknown>) => {
    try {
      const { writeTextFile, mkdir, exists } = await import(
        "@tauri-apps/plugin-fs"
      );
      const dataDir = await getDataDir();
      const configPath = dataDir + "/config.json";

      if (!(await exists(dataDir))) {
        await mkdir(dataDir, { recursive: true });
      }

      await writeTextFile(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error("Failed to save config", e);
    }
  };

  const saveApiKey = async () => {
    if (!apiKey.trim()) {
      showToast("Please enter an API key", "error");
      return;
    }

    try {
      addLog("Validating API key...", "info");
      await invoke("validate_api_key", { apiKey: apiKey.trim() });

      const config: Record<string, unknown> = { apiKey: apiKey.trim() };
      if (serverDescription) config.serverDescription = serverDescription;
      if (Object.keys(toolDescriptions).length > 0)
        config.toolDescriptions = toolDescriptions;

      await saveConfig(config);

      setSavedApiKey(apiKey);
      addLog("API key validated and saved", "success");
      showToast("API key saved successfully", "success");
    } catch (e) {
      addLog(`Failed to save API key: ${e}`, "error");
      showToast("Invalid API key", "error");
    }
  };

  const saveToolCustomizations = async () => {
    try {
      const config: Record<string, unknown> = {};
      if (savedApiKey) config.apiKey = savedApiKey;
      if (serverDescription) config.serverDescription = serverDescription;

      // Only save non-empty custom descriptions
      const filteredDescriptions: Record<string, string> = {};
      for (const [name, desc] of Object.entries(toolDescriptions)) {
        if (desc.trim()) {
          filteredDescriptions[name] = desc.trim();
        }
      }
      if (Object.keys(filteredDescriptions).length > 0) {
        config.toolDescriptions = filteredDescriptions;
      }

      await saveConfig(config);
      setHasUnsavedChanges(false);
      addLog("Tool customizations saved", "success");
      showToast(
        "Customizations saved! Restart your MCP client to apply changes.",
        "success",
      );
    } catch (e) {
      addLog(`Failed to save customizations: ${e}`, "error");
      showToast("Failed to save customizations", "error");
    }
  };

  const getToolDescription = (toolName: string): string => {
    // Return custom description if set, otherwise return default
    if (toolDescriptions[toolName] !== undefined) {
      return toolDescriptions[toolName];
    }
    const tool = defaultTools.find((t) => t.name === toolName);
    return tool?.defaultDescription || "";
  };

  const updateToolDescription = (toolName: string, description: string) => {
    setToolDescriptions((prev) => ({
      ...prev,
      [toolName]: description,
    }));
    setHasUnsavedChanges(true);
  };

  const resetToolDescription = (toolName: string) => {
    setToolDescriptions((prev) => {
      const updated = { ...prev };
      delete updated[toolName];
      return updated;
    });
    setHasUnsavedChanges(true);
  };

  const resetServerDescription = () => {
    setServerDescription("");
    setHasUnsavedChanges(true);
  };

  const loadBookmarks = async () => {
    setBookmarksLoading(true);
    try {
      const result = await invoke<Bookmark[]>("get_bookmarks");
      setBookmarks(result);
    } catch (e) {
      console.error("Failed to load bookmarks:", e);
      addLog(`Failed to load bookmarks: ${e}`, "error");
    } finally {
      setBookmarksLoading(false);
    }
  };

  const deleteBookmark = async (name: string) => {
    try {
      await invoke("delete_bookmark", { name });
      setBookmarks((prev) => prev.filter((b) => b.name !== name));
      showToast(`Bookmark "${name}" deleted`, "success");
      addLog(`Deleted bookmark: ${name}`, "info");
    } catch (e) {
      console.error("Failed to delete bookmark:", e);
      showToast("Failed to delete bookmark", "error");
    }
  };

  const startEditingContext = (bookmark: Bookmark) => {
    setEditingBookmark(bookmark.name);
    setEditingContext(bookmark.context || "");
  };

  const cancelEditingContext = () => {
    setEditingBookmark(null);
    setEditingContext("");
  };

  const saveBookmarkContext = async (name: string) => {
    try {
      const context = editingContext.trim() || null;
      await invoke("update_bookmark_context", { name, context });
      setBookmarks((prev) =>
        prev.map((b) => (b.name === name ? { ...b, context } : b)),
      );
      setEditingBookmark(null);
      setEditingContext("");
      showToast("Context updated", "success");
      addLog(`Updated context for bookmark: ${name}`, "info");
    } catch (e) {
      console.error("Failed to update bookmark context:", e);
      showToast("Failed to update context", "error");
    }
  };

  const formatDate = (dateStr: string | null): string => {
    if (!dateStr) return "N/A";
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  const clearApiKey = async () => {
    try {
      const config: Record<string, unknown> = {};
      if (serverDescription) config.serverDescription = serverDescription;

      // Keep tool customizations
      const filteredDescriptions: Record<string, string> = {};
      for (const [name, desc] of Object.entries(toolDescriptions)) {
        if (desc.trim()) {
          filteredDescriptions[name] = desc.trim();
        }
      }
      if (Object.keys(filteredDescriptions).length > 0) {
        config.toolDescriptions = filteredDescriptions;
      }

      await saveConfig(config);
      setApiKey("");
      setSavedApiKey("");
      addLog("API key cleared", "info");
      showToast("API key cleared", "success");
    } catch (e) {
      addLog(`Failed to clear API key: ${e}`, "error");
      showToast("Failed to clear API key", "error");
    }
  };

  const maskApiKey = (key: string): string => {
    if (key.length <= 8) return "••••••••";
    return key.substring(0, 4) + "••••••••" + key.substring(key.length - 4);
  };

  const isToolCustomized = (toolName: string): boolean => {
    if (toolDescriptions[toolName] === undefined) return false;
    const tool = defaultTools.find((t) => t.name === toolName);
    return toolDescriptions[toolName] !== tool?.defaultDescription;
  };

  const toggleToolExpanded = (toolName: string) => {
    setExpandedTools((prev) => {
      const updated = new Set(prev);
      if (updated.has(toolName)) {
        updated.delete(toolName);
      } else {
        updated.add(toolName);
      }
      return updated;
    });
  };

  const addLog = (message: string, type: LogEntry["type"] = "info") => {
    setLogs((prev) => [
      ...prev.slice(-50),
      { id: Date.now(), message, type, timestamp: new Date(), source: "app" as const },
    ]);
  };

  const showToast = (message: string, type: "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const copyConfig = (config: string) => {
    navigator.clipboard.writeText(config);
    showToast("Configuration copied to clipboard", "success");
  };

  const getClaudeCodeConfig = () => {
    return JSON.stringify(
      {
        mcpServers: {
          workflowy: {
            type: "stdio",
            command: "node",
            args: [
              serverPath ||
                "~/Library/Application Support/workflowy-mcp/server.cjs",
            ],
          },
        },
      },
      null,
      2,
    );
  };

  const getClaudeDesktopConfig = () => {
    return JSON.stringify(
      {
        mcpServers: {
          workflowy: {
            command: "node",
            args: [
              serverPath ||
                "/Users/USERNAME/Library/Application Support/workflowy-mcp/server.cjs",
            ],
          },
        },
      },
      null,
      2,
    );
  };

  const getCursorConfig = () => {
    return JSON.stringify(
      {
        mcpServers: {
          workflowy: {
            command: "node",
            args: [
              serverPath ||
                "/Users/USERNAME/Library/Application Support/workflowy-mcp/server.cjs",
            ],
          },
        },
      },
      null,
      2,
    );
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString("en-US", { hour12: false });
  };

  const getActiveConfig = () => {
    switch (activeTab) {
      case "claude-code":
        return getClaudeCodeConfig();
      case "claude-desktop":
        return getClaudeDesktopConfig();
      case "cursor":
        return getCursorConfig();
    }
  };

  const getConfigPath = () => {
    switch (activeTab) {
      case "claude-code":
        return "~/.claude.json";
      case "claude-desktop":
        return "~/Library/Application Support/Claude/claude_desktop_config.json";
      case "cursor":
        return "~/.cursor/mcp.json";
    }
  };

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <div className="sidebar">
        <div className="sidebar-header">
          <h1>Workflowy Local MCP</h1>
        </div>
        <div className="sidebar-nav">
          <div
            className={`nav-item ${activeSection === "api-key" ? "active" : ""}`}
            onClick={() => setActiveSection("api-key")}
          >
            <span>API Key</span>
          </div>
          <div
            className={`nav-item ${activeSection === "setup" ? "active" : ""}`}
            onClick={() => setActiveSection("setup")}
          >
            <span>Setup</span>
          </div>
          <div
            className={`nav-item ${activeSection === "tools" ? "active" : ""}`}
            onClick={() => setActiveSection("tools")}
          >
            <span>Customize Tools</span>
          </div>
          <div
            className={`nav-item ${activeSection === "bookmarks" ? "active" : ""}`}
            onClick={() => {
              setActiveSection("bookmarks");
              loadBookmarks();
            }}
          >
            <span>Bookmarks</span>
          </div>
          <div
            className={`nav-item ${activeSection === "cache" ? "active" : ""}`}
            onClick={() => setActiveSection("cache")}
          >
            <span>Cache</span>
          </div>
          <div
            className={`nav-item ${activeSection === "general" ? "active" : ""}`}
            onClick={() => setActiveSection("general")}
          >
            <span>Logs</span>
          </div>
        </div>
        <div className="sidebar-footer">
          {updateAvailable && !updateDismissed && (
            <div className="update-banner">
              <span>v{updateAvailable.version} available</span>
              <div className="update-actions">
                <button 
                  className="update-link" 
                  onClick={openReleasePage}
                >
                  Download
                </button>
                <button 
                  className="update-dismiss" 
                  onClick={() => setUpdateDismissed(true)}
                  title="Dismiss"
                >
                  ×
                </button>
              </div>
            </div>
          )}
          <span className="version">v{APP_VERSION}</span>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        <div className="container">
          {/* Logs Section */}
          {activeSection === "general" && (
            <>
              <div className="header">
                <h1>Logs</h1>
                <p>View activity and status information</p>
              </div>

              <div className="logs-controls">
                <button
                  className="button button-secondary button-small"
                  onClick={clearAllLogs}
                >
                  Clear Logs
                </button>
              </div>

              {/* Activity Log - merged and sorted by timestamp */}
              <div className="log-container">
                {(() => {
                  const allLogs = [...logs, ...mcpLogs].sort(
                    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
                  );
                  if (allLogs.length === 0) {
                    return <div className="log-entry">No activity yet</div>;
                  }
                  return allLogs.map((log) => (
                    <div key={`${log.source}-${log.id}`} className={`log-entry ${log.type}`}>
                      [{formatTime(log.timestamp)}] <span className={`log-source log-source-${log.source}`}>[{log.source.toUpperCase()}]</span> {log.message}
                    </div>
                  ));
                })()}
              </div>
            </>
          )}

          {/* API Key Section */}
          {activeSection === "api-key" && (
            <>
              <div className="header">
                <h1>API Key</h1>
                <p>Configure your Workflowy API key</p>
              </div>

              {savedApiKey ? (
                <>
                  <div className="api-key-status">
                    <div className="api-key-info">
                      <span className="api-key-label">Current API Key:</span>
                      <code className="api-key-masked">
                        {maskApiKey(savedApiKey)}
                      </code>
                    </div>
                    <span className="api-key-validated">Validated</span>
                  </div>
                  <div className="api-key-actions">
                    <button
                      className="button button-secondary"
                      onClick={() => {
                        setSavedApiKey("");
                        setApiKey("");
                      }}
                    >
                      Change Key
                    </button>
                    <button
                      className="button button-danger"
                      onClick={clearApiKey}
                    >
                      Clear Key
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="input-group">
                    <label>API Key</label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="wf_xxxxxxxxxxxx"
                    />
                  </div>
                  <button
                    className="button button-primary"
                    onClick={saveApiKey}
                  >
                    Validate & Save
                  </button>
                </>
              )}
            </>
          )}

          {/* Tools Section */}
          {activeSection === "tools" && (
            <>
              <div className="header">
                <h1>Customize Tools</h1>
                <p>Customize how the AI understands and uses Workflowy tools</p>
              </div>

              <div className="input-group">
                <label>Server Instructions</label>
                <p className="field-hint">
                  These instructions help the AI understand how to use the
                  Workflowy tools effectively.
                </p>
                <div className="description-with-reset">
                  <textarea
                    value={serverDescription || defaultServerInstructions}
                    onChange={(e) => {
                      setServerDescription(e.target.value);
                      setHasUnsavedChanges(true);
                    }}
                    rows={12}
                  />
                  {serverDescription && (
                    <button
                      className="reset-button"
                      onClick={resetServerDescription}
                      title="Reset to default instructions"
                    >
                      Reset
                    </button>
                  )}
                </div>
              </div>

              <div className="tools-list">
                <label>Tool Descriptions</label>
                {defaultTools.map((tool) => (
                  <div key={tool.name} className="tool-item">
                    <div
                      className="tool-header"
                      onClick={() => toggleToolExpanded(tool.name)}
                    >
                      <span className="tool-expand-icon">
                        {expandedTools.has(tool.name) ? "▼" : "▶"}
                      </span>
                      <span className="tool-name">{tool.name}</span>
                      {isToolCustomized(tool.name) && (
                        <span className="tool-customized-badge">
                          customized
                        </span>
                      )}
                    </div>
                    {expandedTools.has(tool.name) && (
                      <div className="tool-content">
                        <div className="description-with-reset">
                          <textarea
                            value={getToolDescription(tool.name)}
                            onChange={(e) =>
                              updateToolDescription(tool.name, e.target.value)
                            }
                            rows={3}
                          />
                          <button
                            className={`reset-button ${!isToolCustomized(tool.name) ? "reset-disabled" : ""}`}
                            onClick={() => resetToolDescription(tool.name)}
                            disabled={!isToolCustomized(tool.name)}
                            title="Reset to default description"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button
                className={`button button-primary ${!hasUnsavedChanges ? "button-disabled" : ""}`}
                onClick={saveToolCustomizations}
                disabled={!hasUnsavedChanges}
              >
                {hasUnsavedChanges ? "Save Customizations" : "No Changes"}
              </button>
            </>
          )}

          {/* Setup Section */}
          {activeSection === "setup" && (
            <>
              <div className="header">
                <h1>Setup Instructions</h1>
                <p>Configure your MCP client to use Workflowy</p>
              </div>

              <div className="tabs">
                <button
                  className={`tab ${activeTab === "claude-code" ? "active" : ""}`}
                  onClick={() => setActiveTab("claude-code")}
                >
                  Claude Code
                </button>
                <button
                  className={`tab ${activeTab === "claude-desktop" ? "active" : ""}`}
                  onClick={() => setActiveTab("claude-desktop")}
                >
                  Claude Desktop
                </button>
                <button
                  className={`tab ${activeTab === "cursor" ? "active" : ""}`}
                  onClick={() => setActiveTab("cursor")}
                >
                  Cursor
                </button>
              </div>

              <div className="instructions">
                <p>
                  Add this to <code>{getConfigPath()}</code>:
                </p>
              </div>

              <button
                className="copy-button"
                onClick={() => copyConfig(getActiveConfig())}
              >
                Copy Configuration
              </button>
              <div className="config-preview">{getActiveConfig()}</div>

              <div className="info-box">
                <p>
                  <strong>How it works:</strong> MCP clients like Claude Code
                  spawn the server automatically when needed. No manual server
                  management required.
                </p>
              </div>
            </>
          )}

          {/* Bookmarks Section */}
          {activeSection === "bookmarks" && (
            <>
              <div className="header">
                <h1>Bookmarks</h1>
                <p>View and manage saved Workflowy node bookmarks</p>
              </div>

              <div className="bookmarks-actions">
                <button
                  className="button button-secondary"
                  onClick={loadBookmarks}
                  disabled={bookmarksLoading}
                >
                  {bookmarksLoading ? "Loading..." : "Refresh"}
                </button>
              </div>

              {bookmarksLoading ? (
                <div className="bookmarks-loading">Loading bookmarks...</div>
              ) : bookmarks.length === 0 ? (
                <div className="bookmarks-empty">
                  <p>No bookmarks saved yet.</p>
                  <p className="hint">
                    Bookmarks are created when an LLM uses the save_bookmark
                    tool to remember Workflowy node locations.
                  </p>
                </div>
              ) : (
                <div className="bookmarks-list">
                  {bookmarks.map((bookmark) => (
                    <div key={bookmark.name} className="bookmark-card">
                      <div className="bookmark-card-header">
                        <span className="bookmark-name">{bookmark.name}</span>
                        <span className="bookmark-date">
                          {formatDate(bookmark.created_at)}
                        </span>
                      </div>
                      <div className="bookmark-node-id">
                        <code title={bookmark.node_id}>{bookmark.node_id}</code>
                      </div>
                      <div className="bookmark-context-section">
                        <label className="bookmark-context-label">
                          Context (LLM notes):
                        </label>
                        {editingBookmark === bookmark.name ? (
                          <div className="bookmark-context-edit">
                            <textarea
                              value={editingContext}
                              onChange={(e) => setEditingContext(e.target.value)}
                              placeholder="Notes about what this node contains and how to use it..."
                              rows={3}
                            />
                            <div className="bookmark-context-actions">
                              <button
                                className="button button-primary button-small"
                                onClick={() => saveBookmarkContext(bookmark.name)}
                              >
                                Save
                              </button>
                              <button
                                className="button button-secondary button-small"
                                onClick={cancelEditingContext}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="bookmark-context-display">
                            {bookmark.context ? (
                              <p className="bookmark-context-text">
                                {bookmark.context}
                              </p>
                            ) : (
                              <p className="bookmark-context-empty">
                                No context set. Click Edit to add notes.
                              </p>
                            )}
                            <button
                              className="button button-secondary button-small"
                              onClick={() => startEditingContext(bookmark)}
                            >
                              Edit
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="bookmark-card-actions">
                        <button
                          className="button button-danger button-small"
                          onClick={() => deleteBookmark(bookmark.name)}
                          title="Delete bookmark"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Cache Section */}
          {activeSection === "cache" && (
            <>
              <div className="header">
                <h1>Node Cache</h1>
                <p>
                  Local cache for fast searching. The cache syncs automatically
                  when the MCP server starts.
                </p>
              </div>

              {!savedApiKey ? (
                <div className="info-box">
                  <p>
                    <strong>API Key Required:</strong> Please configure your API
                    key first to use cache features.
                  </p>
                </div>
              ) : (
                <>
                  <div className="cache-status">
                    <h3>Cache Status</h3>
                    {cacheStatus ? (
                      <div className="status-grid">
                        <div className="status-item">
                          <span className="status-label">Status:</span>
                          <span
                            className={`status-value ${cacheStatus.cache_populated ? "status-good" : "status-warning"}`}
                          >
                            {cacheStatus.cache_populated
                              ? "Populated"
                              : "Empty"}
                          </span>
                        </div>
                        {cacheStatus.node_count >= 0 && (
                          <div className="status-item">
                            <span className="status-label">Nodes:</span>
                            <span className="status-value">
                              {cacheStatus.node_count.toLocaleString()}
                            </span>
                          </div>
                        )}
                        <div className="status-item">
                          <span className="status-label">Last Sync:</span>
                          <span className="status-value">
                            {cacheStatus.last_sync === "never"
                              ? "Never"
                              : cacheStatus.last_sync === "Check via MCP tools"
                                ? "Check via MCP tools"
                                : new Date(
                                    cacheStatus.last_sync,
                                  ).toLocaleString()}
                          </span>
                        </div>
                        {cacheStatus.hours_since_sync !== null && (
                          <div className="status-item">
                            <span className="status-label">Freshness:</span>
                            <span
                              className={`status-value ${cacheStatus.is_stale ? "status-warning" : "status-good"}`}
                            >
                              {cacheStatus.is_stale ? "Stale" : "Fresh"}
                              {cacheStatus.hours_since_sync !== null &&
                                ` (${cacheStatus.hours_since_sync.toFixed(1)}h ago)`}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p>Loading cache status...</p>
                    )}
                  </div>

                  <div className="cache-actions">
                    <button
                      className={`button button-primary ${isSyncing || syncCooldown > 0 ? "button-disabled" : ""}`}
                      onClick={syncNow}
                      disabled={isSyncing || syncCooldown > 0}
                    >
                      {isSyncing
                        ? "Syncing..."
                        : syncCooldown > 0
                          ? `Wait ${syncCooldown}s`
                          : "Sync Now"}
                    </button>
                    <button
                      className="button button-secondary"
                      onClick={loadCacheStatus}
                    >
                      Refresh Status
                    </button>
                  </div>

                  <div className="info-box">
                    <p>
                      <strong>Note:</strong> The cache is managed by the MCP
                      server. Use the <code>sync_nodes</code> tool via your MCP
                      client for persistent syncing, or use the{" "}
                      <code>search_nodes</code> tool to search cached content.
                    </p>
                    <p style={{ marginTop: "8px" }}>
                      <strong>Rate Limit:</strong> The Workflowy API limits
                      export requests to 1 per minute.
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          {/* Toast */}
          {toast && (
            <div className={`toast ${toast.type}`}>{toast.message}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
