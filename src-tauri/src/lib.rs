use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

/// Copy the MCP server from the app bundle to the user's data directory
fn copy_mcp_server(app: &tauri::App) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // The server is bundled at _up_/dist-mcp/server.cjs (due to ../dist-mcp in tauri.conf.json)
    let source = resource_path
        .join("_up_")
        .join("dist-mcp")
        .join("server.cjs");
    let dest = app_data.join("server.cjs");

    // Always copy to ensure we have the latest version
    if source.exists() {
        std::fs::create_dir_all(&app_data)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        std::fs::copy(&source, &dest).map_err(|e| format!("Failed to copy server: {}", e))?;
    }

    Ok(dest)
}

#[tauri::command]
async fn validate_api_key(api_key: String) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let response = client
        .get("https://workflowy.com/api/v1/targets")
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if response.status().is_success() {
        Ok(true)
    } else {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        Err(format!("API error ({}): {}", status, text))
    }
}

#[tauri::command]
fn get_server_path(app_handle: tauri::AppHandle) -> Result<String, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let server_path = app_data.join("server.cjs");
    Ok(server_path.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct Bookmark {
    name: String,
    node_id: String,
    context: Option<String>,
    created_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct McpLogEntry {
    timestamp: String,
    message: String,
    #[serde(alias = "type")]
    log_type: String,
    source: String,
}

#[derive(Deserialize)]
struct AccountConfig {
    id: Option<String>,
    name: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
}

#[derive(Deserialize)]
struct AppConfig {
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    accounts: Option<Vec<AccountConfig>>,
    #[serde(rename = "defaultAccountId")]
    default_account_id: Option<String>,
}

#[derive(Clone)]
struct ResolvedAccount {
    id: String,
}

fn load_app_config(app_data: &PathBuf) -> Result<AppConfig, String> {
    let config_path = app_data.join("config.json");
    if !config_path.exists() {
        return Ok(AppConfig {
            api_key: None,
            accounts: None,
            default_account_id: None,
        });
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config.json: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse config.json: {}", e))
}

fn resolve_account(app_data: &PathBuf, account_id: Option<String>) -> Result<ResolvedAccount, String> {
    let config = load_app_config(app_data)?;

    if let Some(accounts) = config.accounts {
        let valid_accounts: Vec<ResolvedAccount> = accounts
            .into_iter()
            .filter_map(|account| {
                let id = account.id?;
                let name = account.name.unwrap_or_default();
                let api_key = account.api_key.unwrap_or_default();
                if id.trim().is_empty() || name.trim().is_empty() || api_key.trim().is_empty() {
                    None
                } else {
                    Some(ResolvedAccount { id })
                }
            })
            .collect();

        if valid_accounts.is_empty() {
            return Ok(ResolvedAccount {
                id: "default".to_string(),
            });
        }

        if let Some(requested_id) = account_id {
            if let Some(account) = valid_accounts.iter().find(|account| account.id == requested_id) {
                return Ok(account.clone());
            }
        }

        if let Some(default_id) = config.default_account_id {
            if let Some(account) = valid_accounts.iter().find(|account| account.id == default_id) {
                return Ok(account.clone());
            }
        }

        return Ok(valid_accounts[0].clone());
    }

    if config.api_key.unwrap_or_default().trim().is_empty() {
        return Ok(ResolvedAccount {
            id: "default".to_string(),
        });
    }

    Ok(ResolvedAccount {
        id: "default".to_string(),
    })
}

fn account_data_dir(app_data: &PathBuf, account: &ResolvedAccount) -> PathBuf {
    if account.id == "default" {
        app_data.clone()
    } else {
        app_data.join(&account.id)
    }
}

/// Run database migrations to ensure schema is up to date
fn run_migrations(conn: &Connection) -> Result<(), String> {
    // Check if context column exists in bookmarks table
    let mut stmt = conn
        .prepare("PRAGMA table_info(bookmarks)")
        .map_err(|e| format!("Failed to get table info: {}", e))?;
    
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("Failed to query table info: {}", e))?
        .filter_map(|r| r.ok())
        .collect();
    
    // Add context column if it doesn't exist
    if !columns.contains(&"context".to_string()) {
        conn.execute("ALTER TABLE bookmarks ADD COLUMN context TEXT", [])
            .map_err(|e| format!("Failed to add context column: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
fn get_bookmarks(app_handle: tauri::AppHandle, account_id: Option<String>) -> Result<Vec<Bookmark>, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let account = resolve_account(&app_data, account_id)?;
    let db_path = account_data_dir(&app_data, &account).join("bookmarks.db");

    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;
    
    // Run migrations before querying
    run_migrations(&conn)?;

    let mut stmt = conn
        .prepare("SELECT name, node_id, context, created_at FROM bookmarks ORDER BY name")
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let bookmarks = stmt
        .query_map([], |row| {
            Ok(Bookmark {
                name: row.get(0)?,
                node_id: row.get(1)?,
                context: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("Failed to query bookmarks: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(bookmarks)
}

#[tauri::command]
fn delete_bookmark(app_handle: tauri::AppHandle, account_id: Option<String>, name: String) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let account = resolve_account(&app_data, account_id)?;
    let db_path = account_data_dir(&app_data, &account).join("bookmarks.db");

    if !db_path.exists() {
        return Err("Database not found".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    conn.execute("DELETE FROM bookmarks WHERE name = ?", [&name])
        .map_err(|e| format!("Failed to delete bookmark: {}", e))?;

    Ok(())
}

#[tauri::command]
fn update_bookmark_context(
    app_handle: tauri::AppHandle,
    account_id: Option<String>,
    name: String,
    context: Option<String>,
) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let account = resolve_account(&app_data, account_id)?;
    let db_path = account_data_dir(&app_data, &account).join("bookmarks.db");

    if !db_path.exists() {
        return Err("Database not found".to_string());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("Failed to open database: {}", e))?;

    conn.execute(
        "UPDATE bookmarks SET context = ? WHERE name = ?",
        rusqlite::params![context, name],
    )
    .map_err(|e| format!("Failed to update bookmark: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_mcp_logs(app_handle: tauri::AppHandle) -> Result<Vec<McpLogEntry>, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let log_path = app_data.join("mcp-logs.json");

    if !log_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&log_path)
        .map_err(|e| format!("Failed to read mcp-logs.json: {}", e))?;

    let logs: Vec<McpLogEntry> = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse mcp-logs.json: {}", e))?;

    Ok(logs)
}

#[tauri::command]
fn clear_mcp_logs(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let log_path = app_data.join("mcp-logs.json");

    if log_path.exists() {
        std::fs::write(&log_path, "[]")
            .map_err(|e| format!("Failed to clear mcp-logs.json: {}", e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            validate_api_key,
            get_server_path,
            get_bookmarks,
            delete_bookmark,
            update_bookmark_context,
            get_mcp_logs,
            clear_mcp_logs
        ])
        .setup(|app| {
            // Copy MCP server from bundle to data directory
            match copy_mcp_server(app) {
                Ok(path) => println!("MCP server copied to: {:?}", path),
                Err(e) => eprintln!("Warning: Failed to copy MCP server: {}", e),
            }

            #[cfg(desktop)]
            {
                use tauri::image::Image;
                use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};

                let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))
                    .expect("Failed to load app icon");

                let about_metadata = AboutMetadata {
                    name: Some("Workflowy MCP".into()),
                    copyright: Some("Copyright \u{00A9} 2026 Rodolfo Terriquez".into()),
                    icon: Some(icon),
                    ..Default::default()
                };

                let handle = app.handle();

                let app_menu = Submenu::with_items(
                    handle,
                    "Workflowy MCP",
                    true,
                    &[
                        &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::services(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::hide(handle, None)?,
                        &PredefinedMenuItem::hide_others(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::quit(handle, None)?,
                    ],
                )?;

                let edit_menu = Submenu::with_items(
                    handle,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(handle, None)?,
                        &PredefinedMenuItem::redo(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::cut(handle, None)?,
                        &PredefinedMenuItem::copy(handle, None)?,
                        &PredefinedMenuItem::paste(handle, None)?,
                        &PredefinedMenuItem::select_all(handle, None)?,
                    ],
                )?;

                let view_menu = Submenu::with_items(
                    handle,
                    "View",
                    true,
                    &[&PredefinedMenuItem::fullscreen(handle, None)?],
                )?;

                let window_menu = Submenu::with_items(
                    handle,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(handle, None)?,
                        &PredefinedMenuItem::maximize(handle, None)?,
                        &PredefinedMenuItem::separator(handle)?,
                        &PredefinedMenuItem::close_window(handle, None)?,
                    ],
                )?;

                let menu = Menu::with_items(
                    handle,
                    &[&app_menu, &edit_menu, &view_menu, &window_menu],
                )?;

                app.set_menu(menu)?;

                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
