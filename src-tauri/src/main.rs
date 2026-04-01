// 如果你的项目名是 app，这里就是 app_lib
// 如果不确定，可以改为：use tauri_task_app as app_lib; (根据你的 Cargo.toml [package] name 修改)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 直接调用 lib.rs 中的 run 函数    
    app_lib::run();
}