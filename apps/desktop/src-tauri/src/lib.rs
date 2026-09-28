mod commands;
mod daemon_sidecar;
mod mic_permissions;
mod oikb_client;
mod oikb_config;
mod openwebui_client;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

// Mirrors `AppPrefs.keepRunningInTray` (settingsStore.ts) so the
// synchronous `on_window_event` handler below can read it without going
// through the (async) store plugin. The frontend pushes the persisted value
// in via `set_keep_running_in_tray` right after loading prefs at startup,
// and again whenever the Settings toggle changes. Defaults to `true` to
// match today's behavior for the brief window before that first push.
pub struct KeepRunningInTray(pub AtomicBool);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(daemon_sidecar::DaemonState::default())
        .manage(KeepRunningInTray(AtomicBool::new(true)))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:chat.db",
                    vec![
                        tauri_plugin_sql::Migration {
                            version: 1,
                            description: "create conversations and messages tables",
                            sql: "
                                CREATE TABLE conversations (
                                    id TEXT PRIMARY KEY,
                                    title TEXT NOT NULL,
                                    model TEXT NOT NULL,
                                    created_at INTEGER NOT NULL
                                );
                                CREATE TABLE messages (
                                    id TEXT PRIMARY KEY,
                                    conversation_id TEXT NOT NULL REFERENCES conversations(id),
                                    role TEXT NOT NULL,
                                    content TEXT NOT NULL,
                                    created_at INTEGER NOT NULL
                                );
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 2,
                            description: "add token counts to messages",
                            sql: "ALTER TABLE messages ADD COLUMN tokens INTEGER;",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 3,
                            description: "add knowledge base attachments to conversations",
                            sql: "ALTER TABLE conversations ADD COLUMN knowledge_ids TEXT;",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 4,
                            description: "scope conversations by signed-in account",
                            sql: "ALTER TABLE conversations ADD COLUMN account_id TEXT;",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 5,
                            description: "add pin/unread/archive/group organization to conversations",
                            sql: "
                                ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
                                ALTER TABLE conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
                                ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
                                ALTER TABLE conversations ADD COLUMN group_id TEXT;
                                CREATE TABLE groups (
                                    id TEXT PRIMARY KEY,
                                    name TEXT NOT NULL,
                                    account_id TEXT,
                                    created_at INTEGER NOT NULL
                                );
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 6,
                            description: "add attachments to messages",
                            sql: "ALTER TABLE messages ADD COLUMN attachments TEXT;",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 7,
                            description: "remember the shared Open WebUI chat id per conversation",
                            sql: "ALTER TABLE conversations ADD COLUMN openwebui_chat_id TEXT;",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 8,
                            description: "add vote and remote message id for Open WebUI feedback",
                            sql: "
                                ALTER TABLE messages ADD COLUMN vote INTEGER;
                                ALTER TABLE messages ADD COLUMN openwebui_message_id TEXT;
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                    ],
                )
                .build(),
        )
        .on_window_event(|window, event| {
            // Closing the main window hides it to the tray instead of quitting
            // the app — the tray's "Close" item is the only way to actually
            // exit (which then reaches `RunEvent::Exit` below and kills the
            // daemon) — unless the user has turned "keep running in tray"
            // off (KeepRunningInTray state), in which case closing behaves
            // like a normal window and quits the app.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let keep_running = window
                    .state::<KeepRunningInTray>()
                    .0
                    .load(Ordering::Relaxed);
                if keep_running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Stronghold-backed encrypted storage for credentials
            // (settingsStore.ts / oikb_config.rs's plaintext `apiKey`/`token`
            // fields are being migrated to go through this instead). Argon2
            // KDF + an app-local salt file is the plugin's own recommended
            // pattern for turning the passphrase the frontend generates
            // (`lib/secureStore.ts`) into the actual vault encryption key.
            let salt_path = app
                .path()
                .app_local_data_dir()
                .expect("could not resolve app local data dir")
                .join("stronghold-salt.txt");
            app.handle()
                .plugin(tauri_plugin_stronghold::Builder::with_argon2(&salt_path).build())?;

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let close_item = MenuItem::with_id(app, "close", "Close", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &close_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "close" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                mic_permissions::register_permission_handler(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_daemon_status,
            commands::get_daemon_ready,
            commands::get_sync_history,
            commands::test_openwebui_connection,
            commands::list_openwebui_models,
            commands::send_chat_message,
            commands::set_oikb_global_config,
            commands::get_oikb_global_config,
            commands::write_oikb_sources,
            commands::read_oikb_sources,
            commands::ensure_default_yaml_path,
            commands::list_knowledge_bases,
            commands::openwebui_login,
            commands::get_openwebui_current_user,
            commands::trigger_sync,
            commands::restart_daemon,
            commands::clear_sync_history,
            commands::transcribe_audio,
            commands::upload_openwebui_file,
            commands::create_openwebui_chat,
            commands::rate_openwebui_message,
            commands::write_text_file,
            commands::set_keep_running_in_tray,
            commands::frontend_log,
            commands::reset_chat_db,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill our managed oikb daemon child on quit so it never survives
            // the app (no orphaned `uv.exe`/`python.exe` processes). The
            // window's X button now hides to tray instead of closing (see
            // `on_window_event` above), so `app.exit(0)` from the tray's
            // "Close" item is the only real exit path today — `Exit` is what
            // that reaches. `ExitRequested` is kept alongside it defensively
            // for any other OS-level exit path.
            match event {
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                    daemon_sidecar::kill_daemon(app_handle);
                }
                _ => {}
            }
        });
}
