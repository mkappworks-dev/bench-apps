use tauri::State;

use crate::startup_state::StartupStatus;

#[tauri::command]
pub async fn get_startup_status(status: State<'_, StartupStatus>) -> Result<StartupStatus, String> {
    Ok(status.inner().clone())
}
