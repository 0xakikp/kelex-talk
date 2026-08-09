// kelex-talk — Rust shell.
//
// kelex-talk holds no AI logic; it proxies HTTP to the kelex backend and
// hosts the native window/tray/hotkey features. HTTP is proxied here (rather
// than fetched from the webview) because the backend ships no CORS headers,
// which would block a `tauri://localhost` fetch.

mod wake;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use wake::WakeFlags;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, State, WebviewWindow, WindowEvent,
    Wry,
};
use tauri_plugin_autostart::{ManagerExt as _, MacosLauncher};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt as _;

const ORB_SIZE: (f64, f64) = (340.0, 400.0);
const WINDOW_SIZE: (f64, f64) = (520.0, 680.0);

/// User-configurable connection + UX settings, persisted to
/// `<app_config_dir>/settings.json`; the settings panel (M5) edits these.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub backend_url: String,
    pub token: String,
    /// Global summon / push-to-talk shortcut. Tauri accelerator syntax.
    pub hotkey: String,
    /// Remembered window mode — true = decorated/opaque windowed, false = orb.
    /// Starts windowed by default and persists the user's manual tray switch.
    pub windowed: bool,
    /// Always-on Rust-side wake word ("jarvis"). Opt-in (holds the mic).
    pub wake_enabled: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            backend_url: "http://localhost:7777".into(),
            token: "bigflix_internal_secret_2026".into(),
            hotkey: "CmdOrCtrl+Shift+J".into(),
            windowed: true,
            wake_enabled: false,
        }
    }
}

pub struct AppState {
    settings: Mutex<Settings>,
    http: reqwest::Client,
    config_path: PathBuf,
}

impl AppState {
    fn endpoint(&self, path: &str) -> (String, String) {
        let s = self.settings.lock().unwrap();
        let base = s.backend_url.trim_end_matches('/');
        (format!("{base}{path}"), s.token.clone())
    }
}

/// Live native-window state + the tray menu item handles we need to update.
struct Native {
    always_on_top: AtomicBool,
    windowed: AtomicBool, // false = floating orb mode
    aot_item: CheckMenuItem<Wry>,
    mode_item: MenuItem<Wry>,
    wake_item: CheckMenuItem<Wry>,
}

fn load_settings(path: &PathBuf) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

// ── Window helpers ──────────────────────────────────────────────────────

fn summon(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("summon", ());
    }
}

fn toggle_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// Center the window on the *primary* monitor (the one with the menu bar),
/// not whatever display it happened to spawn on. `w.center()` centers on the
/// current monitor, which on a multi-display setup can be the external screen
/// the user isn't looking at — leaving the window seemingly "not showing".
fn center_on_primary(w: &WebviewWindow, size: (f64, f64)) {
    if let Ok(Some(mon)) = w.primary_monitor() {
        let mpos = mon.position();
        let msize = mon.size();
        let scale = mon.scale_factor();
        let win_w = (size.0 * scale) as i32;
        let win_h = (size.1 * scale) as i32;
        let x = mpos.x + (msize.width as i32 - win_w) / 2;
        let y = mpos.y + (msize.height as i32 - win_h) / 2;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    } else {
        let _ = w.center();
    }
}

/// Compact, borderless, transparent floating orb.
fn apply_orb_mode(w: &WebviewWindow) {
    let _ = w.set_decorations(false);
    let _ = w.set_shadow(false); // no rectangular shadow around the invisible window
    let _ = w.set_size(LogicalSize::new(ORB_SIZE.0, ORB_SIZE.1));
    center_on_primary(w, ORB_SIZE);
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("mode", "orb");
}

/// Larger, decorated, opaque window for "sit down and use it" sessions.
fn apply_window_mode(w: &WebviewWindow) {
    let _ = w.set_decorations(true);
    let _ = w.set_shadow(true);
    let _ = w.set_size(LogicalSize::new(WINDOW_SIZE.0, WINDOW_SIZE.1));
    center_on_primary(w, WINDOW_SIZE);
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.emit("mode", "window");
}

// ── Commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

/// Frontend queries this on load so the windowed/orb look survives a webview
/// re-init (otherwise the body class is lost and a decorated window renders
/// transparent — the "translucent windowed" glitch).
#[tauri::command]
fn is_windowed(native: State<'_, Native>) -> bool {
    native.windowed.load(Ordering::Relaxed)
}

#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, json).map_err(|e| e.to_string())?;
    // Re-register the global hotkey live in case it changed.
    let _ = app.global_shortcut().unregister_all();
    if let Err(e) = app.global_shortcut().register(settings.hotkey.as_str()) {
        eprintln!("[kelex-talk] hotkey '{}' register failed: {e}", settings.hotkey);
    }
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
fn get_autostart(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    if enabled { mgr.enable() } else { mgr.disable() }.map_err(|e| e.to_string())
}

/// Enable/disable the always-on wake word + persist the choice.
#[tauri::command]
fn set_wake(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    {
        let mut s = state.settings.lock().unwrap();
        s.wake_enabled = enabled;
        if let Ok(json) = serde_json::to_string_pretty(&*s) {
            let _ = std::fs::write(&state.config_path, json);
        }
    }
    let _ = app.state::<Native>().wake_item.set_checked(enabled);
    if enabled {
        wake::start(&app);
    } else {
        wake::stop(&app);
    }
    Ok(())
}

/// Hush/resume the wake listener (webview calls these around a conversation
/// so the always-on mic doesn't fight getUserMedia).
#[tauri::command]
fn wake_pause(app: AppHandle) {
    wake::set_paused(&app, true);
}
#[tauri::command]
fn wake_resume(app: AppHandle) {
    wake::set_paused(&app, false);
}

/// Show a native OS notification (used for proactive kelex alerts).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn health(state: State<'_, AppState>) -> Result<bool, String> {
    let (url, _) = state.endpoint("/health");
    match state.http.get(&url).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// POST /api/chat — {message, session_id} -> {reply, actions}.
#[tauri::command]
async fn chat(
    state: State<'_, AppState>,
    message: String,
    session: Option<String>,
) -> Result<serde_json::Value, String> {
    let (url, token) = state.endpoint("/api/chat");
    let mut body = serde_json::json!({ "message": message });
    if let Some(sid) = session {
        body["session_id"] = serde_json::Value::String(sid);
    }
    let mut req = state.http.post(&url).json(&body);
    if !token.is_empty() {
        req = req.header("X-Internal-Token", token);
    }
    let resp = req.send().await.map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let val: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad response ({status}): {e}"))?;
    Ok(val)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        summon(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // Tray-resident app: closing the window (red X in windowed mode)
            // hides it instead of quitting. Quit is via the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            // Settings + HTTP client.
            let dir = app.path().app_config_dir().expect("resolve app config dir");
            std::fs::create_dir_all(&dir).ok();
            let config_path = dir.join("settings.json");
            let settings = load_settings(&config_path);
            let hotkey = settings.hotkey.clone();
            let windowed = settings.windowed;
            let wake_enabled = settings.wake_enabled;
            app.manage(AppState {
                settings: Mutex::new(settings),
                http: reqwest::Client::new(),
                config_path,
            });
            app.manage(WakeFlags::new());

            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
                eprintln!("[kelex-talk] failed to register hotkey '{hotkey}': {e}");
            }

            // Tray menu: Show/Hide, Always-on-top (check), Orb⇄Window mode, Quit.
            let toggle_item =
                MenuItem::with_id(app, "toggle", "Show / Hide", true, None::<&str>)?;
            let aot_item =
                CheckMenuItem::with_id(app, "aot", "Always on top", true, true, None::<&str>)?;
            let mode_label = if windowed { "Switch to orb mode" } else { "Switch to window mode" };
            let mode_item = MenuItem::with_id(app, "mode", mode_label, true, None::<&str>)?;
            let wake_item =
                CheckMenuItem::with_id(app, "wake", "Wake word (\"kelex\")", true, wake_enabled, None::<&str>)?;
            let settings_item =
                MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit_item =
                MenuItem::with_id(app, "quit", "Quit kelex-talk", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&toggle_item, &aot_item, &mode_item, &wake_item, &settings_item, &sep, &quit_item],
            )?;

            app.manage(Native {
                always_on_top: AtomicBool::new(true),
                windowed: AtomicBool::new(windowed),
                aot_item: aot_item.clone(),
                mode_item: mode_item.clone(),
                wake_item: wake_item.clone(),
            });

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("kelex-talk")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "toggle" => toggle_window(app),
                    "quit" => app.exit(0),
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("open-settings", ());
                        }
                    }
                    "aot" => {
                        let n = app.state::<Native>();
                        let new = !n.always_on_top.load(Ordering::Relaxed);
                        n.always_on_top.store(new, Ordering::Relaxed);
                        let _ = n.aot_item.set_checked(new);
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.set_always_on_top(new);
                        }
                    }
                    "mode" => {
                        let n = app.state::<Native>();
                        let windowed = !n.windowed.load(Ordering::Relaxed);
                        n.windowed.store(windowed, Ordering::Relaxed);
                        let _ = n.mode_item.set_text(if windowed {
                            "Switch to orb mode"
                        } else {
                            "Switch to window mode"
                        });
                        if let Some(w) = app.get_webview_window("main") {
                            if windowed {
                                apply_window_mode(&w);
                            } else {
                                apply_orb_mode(&w);
                            }
                        }
                        // Persist the manual choice so it survives restarts.
                        let st = app.state::<AppState>();
                        let mut s = st.settings.lock().unwrap();
                        s.windowed = windowed;
                        if let Ok(json) = serde_json::to_string_pretty(&*s) {
                            let _ = std::fs::write(&st.config_path, json);
                        }
                    }
                    "wake" => {
                        let enabled = {
                            let st = app.state::<AppState>();
                            let mut s = st.settings.lock().unwrap();
                            s.wake_enabled = !s.wake_enabled;
                            if let Ok(json) = serde_json::to_string_pretty(&*s) {
                                let _ = std::fs::write(&st.config_path, json);
                            }
                            s.wake_enabled
                        };
                        let _ = app.state::<Native>().wake_item.set_checked(enabled);
                        if enabled {
                            wake::start(app);
                        } else {
                            wake::stop(app);
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Apply the remembered window mode at startup (default: windowed).
            if let Some(w) = app.get_webview_window("main") {
                if windowed {
                    apply_window_mode(&w);
                } else {
                    apply_orb_mode(&w);
                }
            }

            // Start the always-on wake word if the user enabled it.
            if wake_enabled {
                wake::start(&app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_settings,
            is_windowed,
            get_autostart,
            set_autostart,
            set_wake,
            wake_pause,
            wake_resume,
            notify,
            health,
            chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
