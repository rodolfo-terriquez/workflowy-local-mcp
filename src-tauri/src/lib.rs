use rusqlite::Connection;
use serde::Serialize;
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
fn get_bookmarks(app_handle: tauri::AppHandle) -> Result<Vec<Bookmark>, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = app_data.join("bookmarks.db");

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
fn delete_bookmark(app_handle: tauri::AppHandle, name: String) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = app_data.join("bookmarks.db");

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
    name: String,
    context: Option<String>,
) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_path = app_data.join("bookmarks.db");

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            validate_api_key,
            get_server_path,
            get_bookmarks,
            delete_bookmark,
            update_bookmark_context
        ])
        .setup(|app| {
            // Copy MCP server from bundle to data directory
            match copy_mcp_server(app) {
                Ok(path) => println!("MCP server copied to: {:?}", path),
                Err(e) => eprintln!("Warning: Failed to copy MCP server: {}", e),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
