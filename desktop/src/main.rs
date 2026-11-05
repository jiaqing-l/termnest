#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Server {
    port: u16,
    child: Mutex<Option<Child>>,
    closing: AtomicBool,
    finished: AtomicBool,
}

// Window-state is stored under the bundle identifier rather than the launcher's
// data directory. Copy the old state before the plugin loads it; retain its
// filename and the "main" window label across the rename.
fn migrate_window_state(current: &std::path::Path) -> std::io::Result<()> {
    let target = current.join(tauri_plugin_window_state::DEFAULT_FILENAME);
    let Some(parent) = current.parent() else {
        return Ok(());
    };
    let legacy = parent
        .join("com.jiaqing.tmux-dev")
        .join(tauri_plugin_window_state::DEFAULT_FILENAME);
    if target.exists() || !legacy.exists() {
        return Ok(());
    }
    let mut source = std::fs::File::open(legacy)?;
    std::fs::create_dir_all(current)?;
    let mut destination = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error),
    };
    if let Err(error) = std::io::copy(&mut source, &mut destination) {
        drop(destination);
        let _ = std::fs::remove_file(target);
        return Err(error);
    }
    Ok(())
}

fn classify_connect_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::ConnectionRefused
        || (cfg!(windows)
            && (error.kind() == std::io::ErrorKind::TimedOut
                || error.raw_os_error() == Some(10061)))
    {
        "free".into()
    } else {
        error.to_string()
    }
}

// No proxy, redirects, DNS or HTTP client environment settings for discovery.
fn identity(port: u16) -> Result<serde_json::Value, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    // Windows retries closed loopback ports for about two seconds before refusing.
    let connect_timeout = if cfg!(windows) {
        Duration::from_secs(3)
    } else {
        Duration::from_millis(500)
    };
    let mut stream =
        TcpStream::connect_timeout(&address, connect_timeout).map_err(classify_connect_error)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| e.to_string())?;
    write!(
        stream,
        "GET /__app HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    stream
        .take(16384)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let response = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or("invalid HTTP")?;
    if !headers.starts_with("HTTP/1.0 200 ") && !headers.starts_with("HTTP/1.1 200 ") {
        return Err("invalid status".into());
    }
    let value: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    if value["app"] != "tmux-dev" {
        return Err("different app".into());
    }
    Ok(value)
}

// Smoke diagnostics never record navigation URLs or the private setup pipe.
fn diagnostic(message: &str) {
    if let Some(path) = std::env::var_os("TW_DESKTOP_LOG") {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{message}");
        }
    }
}

#[tauri::command]
fn desktop_stage(stage: String) {
    // Accept fixed labels only; page errors can contain setup tokens or URLs.
    if [
        "bridge",
        "dom",
        "fonts",
        "status",
        "terminal",
        "terminal-open",
        "terminal-write",
        "terminal-paste",
        "terminal-resize",
        "ready",
        "failed",
    ]
    .contains(&stage.as_str())
    {
        diagnostic(&format!("webview: {stage}"));
    }
}

fn fail(app: &tauri::AppHandle, message: String) {
    diagnostic(&format!("shell failure: {message}"));
    app.dialog()
        .message(message)
        .title("Termnest")
        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
        .blocking_show();
    stop(app);
}

fn stop(app: &tauri::AppHandle) {
    let state = app.state::<Server>();
    if state.closing.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("Termnest — Đang chờ công việc hoàn tất…");
    }
    let app = app.clone();
    thread::spawn(move || {
        let state = app.state::<Server>();
        // Taking stdin closes the private pipe. Node atomically refuses new work
        // and drains accepted requests before disconnecting terminals.
        let owned = {
            let mut guard = state.child.lock().unwrap();
            if let Some(child) = guard.as_mut() {
                drop(child.stdin.take());
                true
            } else {
                false
            }
        };
        loop {
            let done = if owned {
                state
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map(|child| child.try_wait().map(|s| s.is_some()).unwrap_or(true))
                    .unwrap_or(true)
            } else {
                identity(state.port)
                    .map(|v| v["active_work"].as_u64().unwrap_or(0) == 0)
                    .unwrap_or(true)
            };
            if done {
                break;
            }
            thread::sleep(Duration::from_millis(200));
        }
        state.finished.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

fn external(app: &tauri::AppHandle, url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Chỉ mở liên kết HTTP hoặc HTTPS.".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    external(&app, &url)
}

#[tauri::command]
fn set_fullscreen(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Không tìm thấy cửa sổ Termnest.".to_string())?
        .set_fullscreen(enabled)
        .map_err(|e| e.to_string())
}

// CI waits for the actual page to render and complete authenticated startup
// requests, then invoke Rust through the same origin-scoped bridge as exports.
#[tauri::command]
fn desktop_smoke() -> bool {
    std::env::var_os("TW_DESKTOP_SMOKE_FILE").is_some()
}

#[tauri::command]
fn desktop_ready(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(path) = std::env::var("TW_DESKTOP_SMOKE_FILE") {
        std::fs::write(path, "webview-ready").map_err(|e| e.to_string())?;
        stop(&app);
    }
    Ok(())
}

#[tauri::command]
async fn save_export(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<(), String> {
    if data.len() > 20_000_000 {
        return Err("Tệp quá lớn (tối đa 20 MB).".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let name = std::path::Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download.txt");
        if let Some(path) = app.dialog().file().set_file_name(name).blocking_save_file() {
            let path = path.into_path().map_err(|e| e.to_string())?;
            std::fs::write(path, data).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn start(app: tauri::AppHandle) {
    diagnostic("starting server discovery");
    let state = app.state::<Server>();
    let port = state.port;
    match identity(port) {
        Ok(_) => (), // Reuse a source or packaged server without owning its lifetime.
        Err(e) if e == "free" => {
            let result = (|| -> Result<(), String> {
                let resources = app
                    .path()
                    .resource_dir()
                    .map_err(|e| e.to_string())?
                    .join("app");
                let sidecar = resources.join(if cfg!(windows) {
                    "node.exe"
                } else if cfg!(target_arch = "aarch64") {
                    "node-arm64"
                } else {
                    "node-x64"
                });
                let mut guard = state.child.lock().unwrap();
                if state.closing.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let mut command = Command::new(sidecar);
                command
                    .arg(resources.join("launcher.js"))
                    .args(["--no-open", "--desktop-pipe"])
                    .env("TW_PORT", port.to_string())
                    .env(
                        "PATH",
                        if cfg!(target_os = "macos") {
                            format!(
                                "/opt/homebrew/bin:/usr/local/bin:{}",
                                std::env::var("PATH").unwrap_or_default()
                            )
                        } else {
                            std::env::var("PATH").unwrap_or_default()
                        },
                    )
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000); // CREATE_NO_WINDOW, retain inherited pipe.
                }
                if let Some(path) = std::env::var_os("TW_DESKTOP_SERVER_LOG") {
                    let log = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .map_err(|e| e.to_string())?;
                    command.stderr(Stdio::from(log));
                }
                diagnostic("spawning bundled Node launcher");
                *guard = Some(command.spawn().map_err(|e| e.to_string())?);
                Ok(())
            })();
            if let Err(e) = result {
                fail(&app, format!("Không thể khởi động máy chủ Termnest ở cổng {port}.\n{e}\nHãy cài lại ứng dụng rồi thử lại."));
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                if state.closing.load(Ordering::SeqCst) {
                    return;
                }
                if identity(port).is_ok() {
                    break;
                }
                let exited = state
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map(|c| c.try_wait().map(|v| v.is_some()).unwrap_or(true))
                    .unwrap_or(true);
                if exited || Instant::now() >= deadline {
                    fail(&app, format!("Máy chủ Termnest không sẵn sàng ở cổng {port}.\nCổng có thể đang được dùng hoặc ứng dụng bị chặn. Hãy kiểm tra rồi mở lại."));
                    return;
                }
                thread::sleep(Duration::from_millis(200));
            }
        }
        Err(_) => {
            fail(&app, format!("Cổng {port} đang được chương trình khác sử dụng hoặc không trả lời đúng Termnest.\nHãy đóng chương trình đó rồi mở lại."));
            return;
        }
    }
    if state.closing.load(Ordering::SeqCst) {
        return;
    }
    diagnostic("server identity ready");
    let mut url = format!("http://127.0.0.1:{port}/");
    // Private anonymous pipe, never stdout/logs or an unauthenticated HTTP endpoint.
    let output = state
        .child
        .lock()
        .unwrap()
        .as_mut()
        .and_then(|child| child.stdout.take());
    if let Some(output) = output {
        let mut line = String::new();
        let mut reader = BufReader::new(output);
        let read = reader.by_ref().take(4096).read_line(&mut line);
        thread::spawn(move || {
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        if read.is_err() {
            fail(
                &app,
                "Không nhận được thông tin khởi động. Hãy mở lại ứng dụng.".into(),
            );
            return;
        }
        // An empty pipe is allowed only when another Termnest won the bind race.
        if line.is_empty() {
            if let Some(mut child) = state.child.lock().unwrap().take() {
                let _ = child.wait(); // Reap the losing launcher, not just its stdout pipe.
            }
        } else {
            let value = serde_json::from_str::<serde_json::Value>(&line);
            match value {
                Ok(value) if value["setupToken"].is_null() => (),
                Ok(value)
                    if value["setupToken"].as_str().is_some_and(|t| {
                        t.len() == 48 && t.chars().all(|c| c.is_ascii_hexdigit())
                    }) =>
                {
                    url.push_str(&format!("#setup={}", value["setupToken"].as_str().unwrap()));
                }
                _ => {
                    fail(
                        &app,
                        "Thông tin khởi động không hợp lệ. Hãy mở lại ứng dụng.".into(),
                    );
                    return;
                }
            }
        }
    }
    diagnostic("navigating to local app");
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.navigate(url.parse().unwrap()) {
            fail(&app, format!("Không mở được cửa sổ Termnest: {e}"));
            return;
        }
    }
    loop {
        thread::sleep(Duration::from_millis(300));
        if state.closing.load(Ordering::SeqCst) {
            return;
        }
        let status = state
            .child
            .lock()
            .unwrap()
            .as_mut()
            .and_then(|c| c.try_wait().ok().flatten());
        if let Some(status) = status {
            if status.success() && identity(port).is_ok() {
                // Another Termnest won the startup bind race. Our sidecar exited
                // after identifying it; keep the window, but never own that server.
                *state.child.lock().unwrap() = None;
            } else {
                if status.success() {
                    stop(&app);
                } else {
                    fail(
                        &app,
                        "Máy chủ Termnest đã dừng bất ngờ. Hãy mở lại ứng dụng.".into(),
                    );
                }
                return;
            }
        }
    }
}

fn main() {
    diagnostic("native process entered main");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        diagnostic(&format!("native panic: {info}"));
        default_hook(info);
    }));
    // A private, explicitly requested smoke run may isolate itself from a user's app.
    // Normal launches always use the product's fixed port, including TW_PORT overrides.
    let port = if std::env::var_os("TW_DESKTOP_SMOKE_FILE").is_some() {
        std::env::var("TW_DESKTOP_SMOKE_PORT").unwrap_or_else(|_| "7681".into())
    } else {
        "7681".into()
    };
    let parsed_port = port.parse::<u16>().ok().filter(|p| *p != 0);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("legacy-window-state")
                .setup(|app, _| {
                    migrate_window_state(&app.path().app_config_dir()?)?;
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        - tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .manage(Server {
            port: parsed_port.unwrap_or(7681),
            child: Mutex::new(None),
            closing: AtomicBool::new(false),
            finished: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            save_export,
            open_external,
            set_fullscreen,
            desktop_ready,
            desktop_smoke,
            desktop_stage
        ])
        .setup(move |app| {
            diagnostic("creating webview");
            let origin = format!("http://127.0.0.1:{}", parsed_port.unwrap_or(7681));
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("local-server")
                    .window("main")
                    .local(false)
                    .remote(format!("{origin}/*"))
                    .permission("desktop-bridge")
                    .permission("clipboard-manager:allow-write-text")
                    .permission("clipboard-manager:allow-read-text")
                    .permission("notification:allow-is-permission-granted")
                    .permission("notification:allow-request-permission")
                    .permission("notification:allow-notify"),
            )?;
            let nav_app = app.handle().clone();
            let popup_app = app.handle().clone();
            let local_origin = origin.clone();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Termnest")
                .inner_size(1180.0, 800.0)
                .min_inner_size(720.0, 500.0)
                .initialization_script(format!(
                    "window.__TMUX_DESKTOP_ORIGIN={origin:?};\n{}",
                    include_str!("bridge.js")
                ))
                .on_page_load(|_, _| diagnostic("webview page load event"))
                .on_navigation(move |url| {
                    if url.origin().ascii_serialization() == local_origin
                        || url.scheme() == "tauri"
                        || url.host_str() == Some("tauri.localhost")
                    {
                        return true;
                    }
                    let _ = external(&nav_app, url.as_str());
                    false
                })
                .on_new_window(move |url, _| {
                    if url.origin().ascii_serialization() == origin {
                        if let Some(w) = popup_app.get_webview_window("main") {
                            let _ = w.navigate(url);
                        }
                    } else {
                        let _ = external(&popup_app, url.as_str());
                    }
                    tauri::webview::NewWindowResponse::Deny
                });
            // On Windows (WebView2) Tauri's own drag-drop handler swallows the page's HTML5 drag and drop: dropping a picture on a session
            // and dragging a file out of the viewer would never reach the page. The app has no native drop handling, so turn it off there.
            #[cfg(windows)]
            let builder = builder.disable_drag_drop_handler();
            builder.build()?;
            diagnostic("webview created");
            // Keep the standard edit shortcuts in WKWebView and a single Quit item.
            // No custom navigation, debug, help or window menus.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
                let menu = Menu::with_items(
                    app,
                    &[
                        &Submenu::with_items(
                            app,
                            "Termnest",
                            true,
                            &[&PredefinedMenuItem::quit(app, Some("Thoát Termnest"))?],
                        )?,
                        &Submenu::with_items(
                            app,
                            "Edit",
                            true,
                            &[
                                &PredefinedMenuItem::undo(app, None)?,
                                &PredefinedMenuItem::redo(app, None)?,
                                &PredefinedMenuItem::cut(app, None)?,
                                &PredefinedMenuItem::copy(app, None)?,
                                &PredefinedMenuItem::paste(app, None)?,
                                &PredefinedMenuItem::select_all(app, None)?,
                            ],
                        )?,
                    ],
                )?;
                app.set_menu(menu)?;
            }
            #[cfg(windows)]
            let _ = app.remove_menu();
            let handle = app.handle().clone();
            thread::spawn(move || {
                if parsed_port.is_none() {
                    fail(&handle, "TW_PORT phải là số từ 1 đến 65535.".into());
                } else {
                    start(handle);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(true)
            ) {
                if let (Ok(enabled), Some(webview)) = (
                    window.is_fullscreen(),
                    window.app_handle().get_webview_window("main"),
                ) {
                    let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('tw-fullscreen',{{detail:{enabled}}}));"));
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                stop(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("Không thể tạo cửa sổ Termnest");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Server>().finished.load(Ordering::SeqCst) {
                api.prevent_exit();
                stop(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn classifies_connect_errors_without_sockets() {
        use std::io::{Error, ErrorKind};

        assert_eq!(
            classify_connect_error(Error::from(ErrorKind::ConnectionRefused)),
            "free"
        );
        for error in [
            Error::from(ErrorKind::TimedOut),
            Error::from_raw_os_error(10061),
        ] {
            let expected = if cfg!(windows) {
                "free".to_string()
            } else {
                error.to_string()
            };
            assert_eq!(classify_connect_error(error), expected);
        }
        let error = Error::new(ErrorKind::PermissionDenied, "probe denied");
        assert_eq!(classify_connect_error(error), "probe denied");
    }

    #[test]
    fn window_state_survives_identifier_change_without_overwriting_new_state() {
        let root = std::env::temp_dir().join(format!(
            "termnest-window-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let current = root.join("com.jiaqing.termnest");
        let legacy = root.join("com.jiaqing.tmux-dev");
        let filename = tauri_plugin_window_state::DEFAULT_FILENAME;
        migrate_window_state(&current).unwrap();
        assert!(!current.exists());
        std::fs::create_dir_all(&legacy).unwrap();
        let state = br#"{"main":{"width":1180,"height":800,"x":12,"y":34}}"#;
        std::fs::write(legacy.join(filename), state).unwrap();
        migrate_window_state(&current).unwrap();
        assert_eq!(std::fs::read(current.join(filename)).unwrap(), state);
        assert_eq!(std::fs::read(legacy.join(filename)).unwrap(), state);
        std::fs::write(current.join(filename), b"new state").unwrap();
        migrate_window_state(&current).unwrap();
        assert_eq!(std::fs::read(current.join(filename)).unwrap(), b"new state");
        std::fs::remove_dir_all(root).unwrap();
    }

    fn probe(response: &'static str) -> Result<serde_json::Value, String> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                if request.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).unwrap();
            assert!(request.starts_with("GET /__app HTTP/1.0\r\n"));
            assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
            socket.write_all(response.as_bytes()).unwrap();
        });
        let result = identity(port);
        server.join().unwrap();
        result
    }

    #[test]
    fn recognizes_only_successful_app_identity() {
        let value =
            probe("HTTP/1.0 200 OK\r\n\r\n{\"app\":\"tmux-dev\",\"active_work\":2}").unwrap();
        assert_eq!(value["active_work"], 2);
        assert!(probe("HTTP/1.0 200 OK\r\n\r\n{\"app\":\"foreign\"}").is_err());
        assert!(probe("HTTP/1.0 500 Error\r\n\r\n{\"app\":\"tmux-dev\"}").is_err());
        assert!(probe("HTTP/1.0 200 OK\r\n\r\nnot json").is_err());
        assert!(probe("not HTTP").is_err());
    }
}
