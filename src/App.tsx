import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

interface LogEntry {
  id: number;
  message: string;
  type: "info" | "success" | "error";
  timestamp: Date;
}

interface ToolDefinition {
  name: string;
  defaultDescription: string;
}

interface Bookmark {
  name: string;
  node_id: string;
  created_at: string | null;
}

// Default server instructions matching the MCP server
const defaultServerInstructions = `This MCP server connects to a user's Workflowy account. Workflowy is an outliner app where notes are organized as nested bullet points (nodes).

## Key Concepts
- Nodes have a UUID (id), name (text content), and optional note (description)
- Nodes can be nested under other nodes (parent_id)
- Special locations: 'inbox', 'home', or 'None' (top-level)

## Bookmarks
Bookmarks let you save node IDs with friendly names. When a user mentions a named location (like "my work inbox" or "project notes"), use list_bookmarks to see all saved bookmarks and pick the one that best matches what the user is referring to.

## Common Workflows

**Adding content to a bookmarked location:**
1. list_bookmarks to see all saved locations
2. Pick the bookmark that best matches what the user mentioned
3. create_node with that node_id as parent_id

**Exploring the hierarchy:**
1. list_nodes with parent_id='None' to see top-level nodes
2. list_nodes with a specific node_id to see its children

## Tips
- Always use list_bookmarks when the user refers to a named location, then pick the best match
- Avoid export_all_nodes unless necessary (rate limited to 1/min)
- Node names support basic formatting and markdown`;

// Default tool definitions matching the MCP server
const defaultTools: ToolDefinition[] = [
  {
    name: "save_bookmark",
    defaultDescription:
      "Save a Workflowy node ID with a friendly name for easy reference later. Check similar bookmarks before creating a new one to avoid duplicates.",
  },
  {
    name: "list_bookmarks",
    defaultDescription:
      "List all saved Workflowy bookmarks. Use this to see what locations have been bookmarked.",
  },
  {
    name: "delete_bookmark",
    defaultDescription: "Delete a saved bookmark by name.",
  },
  {
    name: "list_nodes",
    defaultDescription:
      "List child nodes under a parent. Always use the specified parent_id if you know it. Otherwise, use parent_id='None' for top-level nodes, or use 'inbox'/'home' for those two special locations.",
  },
  {
    name: "get_node",
    defaultDescription: "Get a single node by its ID. Returns the node's name, note, and metadata.",
  },
  {
    name: "export_all_nodes",
    defaultDescription:
      "Export all nodes from the entire Workflowy account. WARNING: Rate limited to 1 request per minute. Use sparingly.",
  },
  {
    name: "get_targets",
    defaultDescription:
      "Get special Workflowy targets like 'inbox' and 'home'. Useful for discovering available special locations.",
  },
  {
    name: "create_node",
    defaultDescription:
      "Create a new node (bullet point) in Workflowy. The node will be added as a child of the specified parent.",
  },
  {
    name: "update_node",
    defaultDescription: "Update an existing node's name or note.",
  },
  {
    name: "delete_node",
    defaultDescription: "Permanently delete a node and all its children. Use with caution.",
  },
  {
    name: "move_node",
    defaultDescription: "Move a node to a different parent location.",
  },
  {
    name: "complete_node",
    defaultDescription: "Mark a node as completed (checked off).",
  },
  {
    name: "uncomplete_node",
    defaultDescription: "Mark a node as not completed (unchecked).",
  },
];

function App() {
  const [apiKey, setApiKey] = useState("");
  const [savedApiKey, setSavedApiKey] = useState("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);
  const [activeTab, setActiveTab] = useState<"claude-code" | "claude-desktop" | "cursor">(
    "claude-code",
  );
  const [activeSection, setActiveSection] = useState<
    "general" | "api-key" | "tools" | "setup" | "bookmarks"
  >("api-key");

  // Tool customization state
  const [serverDescription, setServerDescription] = useState("");
  const [toolDescriptions, setToolDescriptions] = useState<Record<string, string>>({});
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [serverPath, setServerPath] = useState("");

  // Bookmarks state
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarksLoading, setBookmarksLoading] = useState(false);

  useEffect(() => {
    loadConfig();
    loadServerPath();
  }, []);

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
      const { writeTextFile, mkdir, exists } = await import("@tauri-apps/plugin-fs");
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
      if (Object.keys(toolDescriptions).length > 0) config.toolDescriptions = toolDescriptions;

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
      showToast("Customizations saved! Restart your MCP client to apply changes.", "success");
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
      { id: Date.now(), message, type, timestamp: new Date() },
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
            args: [serverPath || "~/Library/Application Support/workflowy-mcp/server.cjs"],
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
              serverPath || "/Users/USERNAME/Library/Application Support/workflowy-mcp/server.cjs",
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
              serverPath || "/Users/USERNAME/Library/Application Support/workflowy-mcp/server.cjs",
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
            className={`nav-item ${activeSection === "general" ? "active" : ""}`}
            onClick={() => setActiveSection("general")}
          >
            <span>Logs</span>
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="version">v1.0.1</span>
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

              {/* Activity Log */}
              <div className="log-container">
                {logs.length === 0 ? (
                  <div className="log-entry">No activity yet</div>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className={`log-entry ${log.type}`}>
                      [{formatTime(log.timestamp)}] {log.message}
                    </div>
                  ))
                )}
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
                      <code className="api-key-masked">{maskApiKey(savedApiKey)}</code>
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
                    <button className="button button-danger" onClick={clearApiKey}>
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
                  <button className="button button-primary" onClick={saveApiKey}>
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
                  These instructions help the AI understand how to use the Workflowy tools
                  effectively.
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
                    <div className="tool-header" onClick={() => toggleToolExpanded(tool.name)}>
                      <span className="tool-expand-icon">
                        {expandedTools.has(tool.name) ? "▼" : "▶"}
                      </span>
                      <span className="tool-name">{tool.name}</span>
                      {isToolCustomized(tool.name) && (
                        <span className="tool-customized-badge">customized</span>
                      )}
                    </div>
                    {expandedTools.has(tool.name) && (
                      <div className="tool-content">
                        <div className="description-with-reset">
                          <textarea
                            value={getToolDescription(tool.name)}
                            onChange={(e) => updateToolDescription(tool.name, e.target.value)}
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

              <button className="copy-button" onClick={() => copyConfig(getActiveConfig())}>
                Copy Configuration
              </button>
              <div className="config-preview">{getActiveConfig()}</div>

              <div className="info-box">
                <p>
                  <strong>How it works:</strong> MCP clients like Claude Code spawn the server
                  automatically when needed. No manual server management required.
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
                    Bookmarks are created when an LLM uses the save_bookmark tool to remember
                    Workflowy node locations.
                  </p>
                </div>
              ) : (
                <div className="bookmarks-list">
                  <div className="bookmarks-table">
                    <div className="bookmarks-header">
                      <span className="bookmark-col-name">Name</span>
                      <span className="bookmark-col-id">Node ID</span>
                      <span className="bookmark-col-date">Created</span>
                      <span className="bookmark-col-actions">Actions</span>
                    </div>
                    {bookmarks.map((bookmark) => (
                      <div key={bookmark.name} className="bookmark-row">
                        <span className="bookmark-col-name" title={bookmark.name}>
                          {bookmark.name}
                        </span>
                        <span className="bookmark-col-id">
                          <code title={bookmark.node_id}>{bookmark.node_id}</code>
                        </span>
                        <span className="bookmark-col-date">{formatDate(bookmark.created_at)}</span>
                        <span className="bookmark-col-actions">
                          <button
                            className="button button-danger button-small"
                            onClick={() => deleteBookmark(bookmark.name)}
                            title="Delete bookmark"
                          >
                            Delete
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Toast */}
          {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}
        </div>
      </div>
    </div>
  );
}

export default App;
