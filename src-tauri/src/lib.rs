use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};
use tauri_plugin_notification::NotificationExt;

#[tauri::command]
fn send_task_notification(app: tauri::AppHandle, title: String, message: String) {
    let _ = app.notification()
        .builder()
        .title(title)
        .body(message)
        .show();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![send_task_notification])
        .setup(|app| {
            // --- 1. 创建托盘右键菜单 ---
            let quit_i = MenuItem::with_id(app, "quit", "退出指令 [EXIT]", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "恢复终端 [SHOW]", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // --- 2. 配置系统托盘 ---
            let _tray = TrayIconBuilder::new()
                // 使用默认图标，确保 tauri.conf.json 中配置了图标路径
                .icon(app.default_window_icon().unwrap().clone()) 
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0); // 彻底退出程序
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // 左键点击图标时恢复窗口
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // --- 3. 关键：拦截关闭按钮事件 ---
        // 这能保证前端的 setTimeout 定时器即使在窗口“关闭”后依然在后台运行
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide(); // 隐藏窗口
                api.prevent_close();   // 阻止进程销毁
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}