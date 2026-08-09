// WebSocket proxy: bridges the Tauri webview to Hermes Gateway.
//
// WebKit's ITP blocks third-party cookies from iframes, so the
// webview can't authenticate with Hermes directly. Instead:
//
//   1. Rust logs into Hermes via reqwest (cookie jar works)
//   2. Rust connects to Hermes WebSocket with the session cookie
//   3. Rust starts a local WS server for the webview
//   4. Messages flow bidirectionally: webview ↔ local WS ↔ Hermes WS
//
// The webview connects to ws://127.0.0.1:<port> with no auth needed.

use std::net::TcpListener;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use reqwest::cookie::Jar;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, accept_async, MaybeTlsStream};
use tauri::AppHandle;

use crate::AppState;

type WsStream = tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Shared state for the proxy: the remote Hermes WS sender, protected by a mutex
/// so the local→remote forwarding loop can push messages into it.
struct ProxyState {
    remote_tx: Mutex<Option<futures_util::stream::SplitSink<WsStream, Message>>>,
}

/// Start the WebSocket proxy. Returns the local WebSocket URL the frontend
/// should connect to (e.g. ws://127.0.0.1:PORT).
pub async fn start_proxy(
    app: AppHandle,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    let (gateway_url, username, password) = {
        let s = state.settings.lock().unwrap();
        (s.gateway_url.clone(), s.username.clone(), s.password_hash.clone())
    };

    if gateway_url.is_empty() {
        return Err("No gateway URL configured".into());
    }

    let base = gateway_url.trim_end_matches('/').to_string();

    // --- Step 1: Login and get session cookie ---
    let cookie_jar = Arc::new(Jar::default());
    let client = reqwest::Client::builder()
        .cookie_provider(cookie_jar.clone())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let login_resp = client
        .post(format!("{base}/auth/password-login"))
        .json(&serde_json::json!({
            "provider": "basic",
            "username": username,
            "password": password,
            "next": "",
        }))
        .send()
        .await
        .map_err(|e| format!("Login request failed: {e}"))?;

    if !login_resp.status().is_success() {
        let status = login_resp.status();
        let body = login_resp.text().await.unwrap_or_default();
        return Err(format!("Login failed ({}): {}", status.as_u16(), body));
    }

    eprintln!("[proxy] Login successful, connecting to Hermes WS");

    // --- Step 2: Connect to remote Hermes WebSocket ---
    let ws_url = format!("{}s://{}/api/ws",
        if base.starts_with("https") { "wss" } else { "ws" },
        base.trim_start_matches("https://").trim_start_matches("http://")
    );

    // Build WebSocket request with cookies from cookie jar
    let mut ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&ws_url)
        .header("Host", ws_url.split("://").nth(1).unwrap_or("").split('/').next().unwrap_or(""));

    // Add cookies
    if let Some(cookie_header) = cookie_jar.cookies(&ws_url.parse().map_err(|e| format!("Bad URL: {e}"))?) {
        let cookie_str: String = cookie_header.to_str().map_err(|e| format!("Cookie header error: {e}"))?.into();
        if !cookie_str.is_empty() {
            ws_request = ws_request.header("Cookie", cookie_str);
        }
    }

    let ws_request = ws_request.body(()).map_err(|e| format!("WS request error: {e}"))?;

    let (remote_ws, _) = connect_async(ws_request)
        .await
        .map_err(|e| format!("WebSocket connection failed: {e}"))?;

    let (remote_tx, mut remote_rx) = remote_ws.split();

    let proxy = Arc::new(ProxyState {
        remote_tx: Mutex::new(Some(remote_tx)),
    });

    // --- Step 3: Start local WebSocket server ---
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to bind local port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| format!("Failed to get port: {e}"))?.port();

    eprintln!("[proxy] Local WS server on port {}", local_port);

    let proxy_clone = proxy.clone();
    let app_handle = app.clone();

    // Spawn the proxy in a background task
    tauri::async_runtime::spawn(async move {
        // Accept ONE local connection from the webview
        let (stream, _) = match listener.accept() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[proxy] Accept error: {e}");
                return;
            }
        };

        let local_ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("[proxy] Local WS upgrade failed: {e}");
                return;
            }
        };

        let (mut local_tx, mut local_rx) = local_ws.split();

        // Forward local → remote
        let proxy_for_rx = proxy_clone.clone();
        let local_to_remote = tokio::spawn(async move {
            while let Some(msg) = local_rx.next().await {
                match msg {
                    Ok(msg) => {
                        let tx = proxy_for_rx.remote_tx.lock().await;
                        if let Some(ref mut tx) = *tx {
                            if let Err(e) = tx.send(msg).await {
                                eprintln!("[proxy] Forward to remote failed: {e}");
                                break;
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[proxy] Local read error: {e}");
                        break;
                    }
                }
            }
        });

        // Forward remote → local
        let remote_to_local = tokio::spawn(async move {
            while let Some(msg) = remote_rx.next().await {
                match msg {
                    Ok(msg) => {
                        if let Err(e) = local_tx.send(msg).await {
                            eprintln!("[proxy] Forward to local failed: {e}");
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("[proxy] Remote read error: {e}");
                        break;
                    }
                }
            }
        });

        // Wait for either direction to end
        tokio::select! {
            _ = local_to_remote => {},
            _ = remote_to_local => {},
        }

        eprintln!("[proxy] Connection closed");

        // Clean up
        let mut tx = proxy_clone.remote_tx.lock().await;
        *tx = None;
    });

    Ok(format!("ws://127.0.0.1:{}", local_port))
}
