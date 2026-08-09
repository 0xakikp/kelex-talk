// WebSocket proxy: bridges Tauri webview to Hermes Gateway.
//
// Rust logs in, gets a single-use WS ticket, connects to Hermes WebSocket,
// then exposes a local WS server for the webview.

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use reqwest::cookie::{Jar, CookieStore};
use rustls::ClientConfig;
use tokio::net::TcpListener;
use tokio_tungstenite::{connect_async_tls_with_config, accept_async, Connector};
use tauri::{AppHandle, Manager};

use crate::AppState;

fn native_connector() -> Result<Connector, String> {
    let mut roots = rustls::RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs().certs;
    for c in certs { let _ = roots.add(c); }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

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

    // Step 1: Login
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
        .send().await.map_err(|e| format!("Login: {e}"))?;

    if !login_resp.status().is_success() {
        return Err(format!("Login failed: {}", login_resp.status()));
    }

    eprintln!("[proxy] Login OK");

    // Step 2: Get WS ticket
    let ticket_resp = client
        .post(format!("{base}/api/auth/ws-ticket"))
        .send().await
        .map_err(|e| format!("Ticket request: {e}"))?;

    if !ticket_resp.status().is_success() {
        return Err(format!("Ticket failed: {}", ticket_resp.status()));
    }

    let ticket_data: serde_json::Value = ticket_resp.json().await
        .map_err(|e| format!("Ticket parse: {e}"))?;

    let ticket = ticket_data["ticket"].as_str()
        .ok_or("No ticket in response")?;

    eprintln!("[proxy] Got WS ticket (valid {}s)", 
        ticket_data["ttl_seconds"].as_u64().unwrap_or(30));

    // Step 3: Connect to Hermes WebSocket with ticket
    let host = base.trim_start_matches("https://").trim_start_matches("http://");
    let ws_scheme = if base.starts_with("https") { "wss" } else { "ws" };
    let ws_url = format!("{ws_scheme}://{host}/api/ws?ticket={}", 
        urlencoding::encode(ticket));

    let connector = native_connector()?;
    eprintln!("[proxy] Connecting to Hermes WS...");
    let (remote_ws, _) = connect_async_tls_with_config(
        tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(&ws_url)
            .body(())
            .map_err(|e| format!("req: {e}"))?,
        None, false, Some(connector),
    )
    .await
    .map_err(|e| format!("WS connect: {e}"))?;

    eprintln!("[proxy] Hermes WS connected!");

    let (mut remote_tx, mut remote_rx) = remote_ws.split();

    // Step 4: Start local WS server
    let listener = TcpListener::bind("127.0.0.1:0").await
        .map_err(|e| format!("Bind: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| format!("Port: {e}"))?.port();

    eprintln!("[proxy] Local WS on 127.0.0.1:{local_port}");

    tauri::async_runtime::spawn(async move {
        let (stream, _) = match listener.accept().await {
            Ok(c) => c,
            Err(_) => return,
        };
        let local_ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(_) => return,
        };
        let (mut local_tx, mut local_rx) = local_ws.split();

        let t1 = tokio::spawn(async move {
            while let Some(Ok(m)) = local_rx.next().await {
                if remote_tx.send(m).await.is_err() { break; }
            }
        });
        let t2 = tokio::spawn(async move {
            while let Some(Ok(m)) = remote_rx.next().await {
                if local_tx.send(m).await.is_err() { break; }
            }
        });
        tokio::select! { _ = t1 => {}, _ = t2 => {} }
        eprintln!("[proxy] Disconnected");
    });

    Ok(format!("ws://127.0.0.1:{local_port}"))
}
