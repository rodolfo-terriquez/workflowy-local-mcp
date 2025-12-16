use tauri::Manager;
use std::path::PathBuf;

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
    let source = resource_path.join("_up_").join("dist-mcp").join("server.cjs");
    let dest = app_data.join("server.cjs");

    // Always copy to ensure we have the latest version
    if source.exists() {
        std::fs::create_dir_all(&app_data)
            .map_err(|e| format!("Failed to create data dir: {}", e))?;
        std::fs::copy(&source, &dest)
            .map_err(|e| format!("Failed to copy server: {}", e))?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![validate_api_key, get_server_path])
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
