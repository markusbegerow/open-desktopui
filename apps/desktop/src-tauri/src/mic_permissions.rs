//! WebView2 auto-rejects microphone permission requests unless the app
//! explicitly handles its native `PermissionRequested` COM event — there is
//! no built-in Tauri API for this (the Web Speech API's `SpeechRecognition`,
//! used by `MicButton.tsx`, would otherwise silently never get microphone
//! access, with no permission prompt shown at all). Windows-only: this app
//! currently only packages for Windows (NSIS/MSI).
#[cfg(target_os = "windows")]
pub fn register_permission_handler(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let result = window.with_webview(|webview| {
        // SAFETY: the COM pointer's lifetime is managed by the webview for as
        // long as the window lives; the handler closure runs synchronously
        // on the webview's own thread, never crossing threads itself.
        let core = unsafe { webview.controller().CoreWebView2().unwrap() };

        let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
            let args: Option<ICoreWebView2PermissionRequestedEventArgs> = args;
            if let Some(args) = args {
                let mut kind = Default::default();
                unsafe { args.PermissionKind(&mut kind).ok() };
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    log::info!("[mic_permissions] granting microphone permission request");
                    unsafe {
                        let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    }
                }
            }
            Ok(())
        }));

        let mut token = Default::default();
        unsafe {
            let _ = core.add_PermissionRequested(&handler, &mut token);
        }
    });

    if let Err(e) = result {
        log::error!("[mic_permissions] with_webview failed: {e:?}");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn register_permission_handler(_window: &tauri::WebviewWindow) {}
