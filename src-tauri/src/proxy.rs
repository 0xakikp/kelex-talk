// WebSocket proxy: bridges the Tauri webview to Hermes Gateway.
//
// Rust handles login + WebSocket with cookies (reqwest cookie jar),
// then exposes a local WS server for the webview. This bypasses
// WebKit's third-party cookie restrictions entirely.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use reqwest::cookie::{Jar, CookieStore};
use rustls::crypto::ring;
use rustls::ClientConfig;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async_tls_with_config, accept_async, Connector};
use tauri::{AppHandle, Manager};

use crate::AppState;

/// Create a TLS connector that trusts system native root certificates.
fn native_tls_connector() -> Result<Connector, String> {
    ring::default_provider()
        .install_default()
        .map_err(|_| "Failed to install crypto provider".to_string())?;

    let mut root_store = rustls::RootCertStore::empty();

    let certs = rustls_native_certs::load_native_certs().certs;

    let mut added = 0;
    for cert in certs {
        if root_store.add(cert).is_ok() {
            added += 1;
        }
    }
    eprintln!("[proxy] Loaded {added} native root certificates");

    let config = ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    Ok(Connector::Rustls(Arc::new(config)))
}

/// Start the WebSocket proxy. Returns the local WebSocket URL.
pub async fn start_proxy(app: AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let (gateway_url, username, password) = {
        let s = state.settings.lock().unwrap();
        (s.gateway_url.clone(), s.username.clone(), s.password_hash.clone())
    };

    if gateway_url.is_empty() {
        return Err("No gateway URL configured".into());
    }

    let base = gateway_url.trim_end_matches('/').to_string();

    // Step 1: Login to Hermes and get session cookie
    let cookie_jar = Arc::new(Jar::default());
    let client = reqwest::Client::builder()
        .cookie_provider(cookie_jar.clone())
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

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
        .map_err(|e| format!("Login failed: {e}"))?;

    if !login_resp.status().is_success() {
        let status = login_resp.status();
        return Err(format!("Login failed ({}): {}", status.as_u16(),
            login_resp.text().await.unwrap_or_default()));
    }

    eprintln!("[proxy] Login OK");

    // Step 2: Connect to Hermes WebSocket with session cookie
    let host = base.trim_start_matches("https://").trim_start_matches("http://");
    let ws_scheme = if base.starts_with("https") { "wss" } else { "ws" };
    let ws_url_str = format!("{ws_scheme}://{host}/api/ws");

    let ws_url: url::Url = ws_url_str.parse().map_err(|e| format!("Bad URL: {e}"))?;

    // Build request with Cookie header
    let mut req_builder = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(ws_url.as_str())
        .header("Host", ws_url.host_str().unwrap_or(""));

    if let Some(cookie_header) = cookie_jar.cookies(&ws_url) {
        if let Ok(cookie_str) = cookie_header.to_str() {
            if !cookie_str.is_empty() {
                req_builder = req_builder.header("Cookie", cookie_str);
            }
        }
    }

    let ws_request = req_builder.body(()).map_err(|e| format!("WS request build: {e}"))?;

    let connector = native_tls_connector()?;
    
    eprintln!("[proxy] Connecting to {ws_url_str}...");
    let (remote_ws, _) = connect_async_tls_with_config(ws_request, None, false, Some(connector))
        .await
        .map_err(|e| format!("Hermes WS connect failed: {e}"))?;

    eprintln!("[proxy] Hermes WS connected!");

    let (mut remote_tx, mut remote_rx) = remote_ws.split();

    // Step 3: Start local WS server
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Bind failed: {e}"))?;

    let local_port = listener.local_addr()
        .map_err(|e| format!("Port error: {e}"))?.port();

    eprintln!("[proxy] Local WS on 127.0.0.1:{local_port}");

    tauri::async_runtime::spawn(async move {
        let (stream, _) = match listener.accept().await {
            Ok(c) => c,
            Err(e) => { eprintln!("[proxy] Accept: {e}"); return; }
        };

        let local_ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(e) => { eprintln!("[proxy] Upgrade: {e}"); return; }
        };

        let (mut local_tx, mut local_rx) = local_ws.split();

        let t1 = tokio::spawn(async move {
            while let Some(msg) = local_rx.next().await {
                match msg {
                    Ok(m) => { if remote_tx.send(m).await.is_err() { break; } }
                    Err(_) => break,
                }
            }
        });

        let t2 = tokio::spawn(async move {
            while let Some(msg) = remote_rx.next().await {
                match msg {
                    Ok(m) => { if local_tx.send(m).await.is_err() { break; } }
                    Err(_) => break,
                }
            }
        });

        tokio::select! {
            _ = t1 => {},
            _ = t2 => {},
        }

        eprintln!("[proxy] Disconnected");
    });

    Ok(format!("ws://127.0.0.1:{local_port}"))
}
