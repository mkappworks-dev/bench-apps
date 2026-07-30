#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::request::fire_request])
        .run(tauri::generate_context!())
        .expect("error while running devbench");
}
