mod commands;
mod daemon_sidecar;
mod mic_permissions;
mod oikb_client;
mod oikb_config;
mod openwebui_client;
mod paste;

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
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
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        // `opendesktopui://` links; after single-instance so a link opened while
        // the app runs reaches the running window instead of starting a second one.
        .plugin(tauri_plugin_deep_link::init())
        // Remembers size and position of the main window (the quick chat window
        // always opens fresh, centered).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["quick"])
                .build(),
        )
        // The quick-chat shortcut is registered from the frontend (it is a
        // user setting); the plugin only provides the OS hook.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
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
        .manage(openwebui_client::ChatCancel::default())
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
                        tauri_plugin_sql::Migration {
                            version: 9,
                            description: "turn groups into Open WebUI-style folders (nesting, icon, system prompt, sync id)",
                            sql: "
                                ALTER TABLE groups ADD COLUMN parent_id TEXT;
                                ALTER TABLE groups ADD COLUMN icon TEXT;
                                ALTER TABLE groups ADD COLUMN system_prompt TEXT;
                                ALTER TABLE groups ADD COLUMN is_expanded INTEGER NOT NULL DEFAULT 1;
                                ALTER TABLE groups ADD COLUMN openwebui_folder_id TEXT;
                                ALTER TABLE groups ADD COLUMN updated_at INTEGER;
                                ALTER TABLE groups ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 10,
                            description: "track chat activity and Open WebUI sync state per conversation",
                            sql: "
                                ALTER TABLE conversations ADD COLUMN updated_at INTEGER;
                                ALTER TABLE conversations ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
                                ALTER TABLE conversations ADD COLUMN deleted_pending INTEGER NOT NULL DEFAULT 0;
                                ALTER TABLE conversations ADD COLUMN server_updated_at INTEGER;
                                ALTER TABLE conversations ADD COLUMN messages_stale INTEGER NOT NULL DEFAULT 0;
                                UPDATE conversations SET updated_at = COALESCE(
                                    (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = conversations.id),
                                    created_at
                                );
                                CREATE INDEX idx_conversations_openwebui_chat_id ON conversations(openwebui_chat_id);
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 11,
                            description: "sync unread state and thumbs feedback records with Open WebUI",
                            sql: "
                                ALTER TABLE conversations ADD COLUMN unread_ack_at INTEGER;
                                ALTER TABLE messages ADD COLUMN feedback_id TEXT;
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 12,
                            description: "tags per conversation, mirrored from Open WebUI",
                            sql: "
                                CREATE TABLE conversation_tags (
                                    conversation_id TEXT NOT NULL,
                                    tag TEXT NOT NULL,
                                    PRIMARY KEY (conversation_id, tag)
                                );
                                CREATE INDEX idx_conversation_tags_tag ON conversation_tags(tag);
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 13,
                            description: "keep a reply's reasoning and retrieved sources apart from its text",
                            sql: "
                                ALTER TABLE messages ADD COLUMN reasoning TEXT;
                                ALTER TABLE messages ADD COLUMN reasoning_seconds INTEGER;
                                ALTER TABLE messages ADD COLUMN sources TEXT;
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 14,
                            description: "per-chat settings (synced) and feature switches (device-local)",
                            sql: "
                                ALTER TABLE conversations ADD COLUMN params TEXT;
                                ALTER TABLE conversations ADD COLUMN features TEXT;
                            ",
                            kind: tauri_plugin_sql::MigrationKind::Up,
                        },
                        tauri_plugin_sql::Migration {
                            version: 15,
                            description: "local copies of the server's prompts, notes and memories (readable offline)",
                            sql: "
                                CREATE TABLE library_prompts (
                                    id TEXT NOT NULL,
                                    account_id TEXT NOT NULL,
                                    command TEXT NOT NULL,
                                    name TEXT NOT NULL,
                                    content TEXT NOT NULL,
                                    PRIMARY KEY (account_id, id)
                                );
                                CREATE TABLE library_notes (
                                    id TEXT NOT NULL,
                                    account_id TEXT NOT NULL,
                                    title TEXT NOT NULL,
                                    markdown TEXT NOT NULL,
                                    pinned INTEGER NOT NULL DEFAULT 0,
                                    created_at INTEGER NOT NULL,
                                    updated_at INTEGER NOT NULL,
                                    PRIMARY KEY (account_id, id)
                                );
                                CREATE TABLE library_memories (
                                    id TEXT NOT NULL,
                                    account_id TEXT NOT NULL,
                                    content TEXT NOT NULL,
                                    updated_at INTEGER NOT NULL,
                                    PRIMARY KEY (account_id, id)
                                );
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
                // The quick chat is throw-away: closing it really closes it, so
                // the next shortcut press opens an empty one.
                if window.label() == "quick" {
                    return;
                }
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

            // In development (and for portable installs) the OS doesn't know the
            // scheme yet; registering it makes `opendesktopui://` links work.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    log::warn!("could not register the opendesktopui:// scheme: {e}");
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let close_item = MenuItem::with_id(app, "close", "Close", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &close_item])?;

            // The only tray: `tauri.conf.json` must not declare a `trayIcon`
            // too, or Windows shows two icons. Left click opens the window,
            // right click shows the menu.
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Open DesktopUI")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                })
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
            commands::cancel_chat_message,
            commands::set_oikb_global_config,
            commands::get_oikb_global_config,
            commands::write_oikb_sources,
            commands::read_oikb_sources,
            commands::ensure_default_yaml_path,
            commands::list_knowledge_bases,
            commands::openwebui_login,
            commands::get_openwebui_current_user,
            commands::fetch_openwebui_profile_image,
            commands::trigger_sync,
            commands::restart_daemon,
            commands::clear_sync_history,
            commands::transcribe_audio,
            commands::upload_openwebui_file,
            commands::create_openwebui_chat,
            commands::list_openwebui_folders,
            commands::create_openwebui_folder,
            commands::update_openwebui_folder,
            commands::update_openwebui_folder_parent,
            commands::update_openwebui_folder_expanded,
            commands::delete_openwebui_folder,
            commands::move_openwebui_chat_to_folder,
            commands::list_openwebui_chats,
            commands::get_openwebui_chat,
            commands::update_openwebui_chat_title,
            commands::update_openwebui_chat_content,
            commands::delete_openwebui_chat,
            commands::set_openwebui_chat_flag,
            commands::mark_openwebui_chat_unread,
            commands::list_openwebui_prompts,
            commands::list_openwebui_notes,
            commands::list_openwebui_files,
            commands::fetch_web_page,
            commands::create_openwebui_note,
            commands::update_openwebui_note,
            commands::delete_openwebui_note,
            commands::list_openwebui_memories,
            commands::add_openwebui_memory,
            commands::update_openwebui_memory,
            commands::delete_openwebui_memory,
            commands::get_openwebui_server_features,
            commands::list_openwebui_tools,
            commands::show_quick_chat,
            commands::open_in_main_window,
            commands::save_pasted_image,
            commands::open_openwebui_file,
            commands::generate_openwebui_title,
            commands::add_openwebui_chat_tag,
            commands::remove_openwebui_chat_tag,
            commands::rate_openwebui_message,
            commands::save_text_file,
            commands::pick_avatar_image,
            commands::set_keep_running_in_tray,
            commands::frontend_log,
            commands::reset_chat_db,
            commands::reset_vault,
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
