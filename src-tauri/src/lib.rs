use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Runtime,
};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_autostart::MacosLauncher; // 引入自启插件需要的 Trait

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
        // --- 1. 注册所有插件 ---
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        // 合并自启插件初始化
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::AppleScript, 
            core::option::Option::Some(vec!["--autostart"]) 
        ))
        
        .invoke_handler(tauri::generate_handler![send_task_notification])
        
        .setup(|app| {
            // --- 2. 创建托盘右键菜单 ---
            let quit_i = MenuItem::with_id(app, "quit", "退出指令 [EXIT]", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "恢复终端 [SHOW]", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // --- 3. 配置系统托盘 ---
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone()) 
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0); 
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

            // --- 4. 处理开机自启时的静默启动 (可选) ---
            // 如果检测到启动参数包含 --autostart，则初始化时不显示窗口
            let args: Vec<String> = std::env::args().collect();
            if args.contains(&"--autostart".to_string()) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        
        // --- 5. 拦截关闭按钮事件，转为隐藏 ---
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let _ = window.hide(); 
                api.prevent_close(); 
            }
            _ => {}
        })
        
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}