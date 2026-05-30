use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// ── Shared state ──────────────────────────────────────────────────────────────

struct SidecarState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
}

struct ProxyState {
    /// Currently bound ports reported by the sidecar via `[cnproxy:ready]`.
    proxy_port: u16,
    web_port: u16,
    /// Whether macOS system proxy is currently pointing at us.
    system_proxy_on: bool,
}

// ── Tauri commands (exposed to the frontend) ─────────────────────────────────

#[tauri::command]
fn get_proxy_ports(state: tauri::State<'_, Mutex<ProxyState>>) -> serde_json::Value {
    let s = state.lock().unwrap();
    serde_json::json!({
        "proxyPort": s.proxy_port,
        "webPort": s.web_port,
    })
}

/// Toggle macOS system HTTP/HTTPS proxy to point at cnproxy.
#[tauri::command]
fn toggle_system_proxy(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<ProxyState>>,
) -> Result<serde_json::Value, String> {
    let mut s = state.lock().unwrap();
    let enable = !s.system_proxy_on;

    if cfg!(target_os = "macos") {
        let port = s.proxy_port;
        let services = network_services_macos();

        for svc in &services {
            if enable {
                run_cmd("networksetup", &["-setwebproxy", svc, "127.0.0.1", &port.to_string()]);
                run_cmd("networksetup", &["-setsecurewebproxy", svc, "127.0.0.1", &port.to_string()]);
                run_cmd("networksetup", &["-setsocksfirewallproxy", svc, "127.0.0.1", &port.to_string()]);
            } else {
                run_cmd("networksetup", &["-setwebproxystate", svc, "off"]);
                run_cmd("networksetup", &["-setsecurewebproxystate", svc, "off"]);
                run_cmd("networksetup", &["-setsocksfirewallproxystate", svc, "off"]);
            }
        }
    } else if cfg!(target_os = "windows") {
        // Windows: set registry keys for Internet Settings
        let port_str = s.proxy_port.to_string();
        if enable {
            // Enable proxy and set server
            run_cmd("reg", &["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "1", "/f"]);
            run_cmd("reg", &["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyServer", "/t", "REG_SZ", "/d", &format!("127.0.0.1:{}", port_str), "/f"]);
        } else {
            run_cmd("reg", &["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", "ProxyEnable", "/t", "REG_DWORD", "/d", "0", "/f"]);
        }
    } else if cfg!(target_os = "linux") {
        // Linux (GNOME): gsettings
        let port_str = s.proxy_port.to_string();
        if enable {
            run_cmd("gsettings", &["set", "org.gnome.system.proxy", "mode", "manual"]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.http", "host", "127.0.0.1"]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.http", "port", &port_str]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.https", "host", "127.0.0.1"]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.https", "port", &port_str]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.socks", "host", "127.0.0.1"]);
            run_cmd("gsettings", &["set", "org.gnome.system.proxy.socks", "port", &port_str]);
        } else {
            run_cmd("gsettings", &["set", "org.gnome.system.proxy", "mode", "none"]);
        }
    }

    s.system_proxy_on = enable;

    let _ = app.emit(
        "proxy-status",
        serde_json::json!({ "systemProxyOn": enable }),
    );

    Ok(serde_json::json!({ "systemProxyOn": enable }))
}

/// Get the path to the cnproxy CA certificate (from the sidecar's data dir).
/// Falls back to `~/.cnproxy/certs/ca.crt`.
#[tauri::command]
fn get_ca_cert_path() -> Result<String, String> {
    let home = dirs_home()?;
    Ok(format!("{}/.cnproxy/certs/ca.crt", home))
}

/// Install the cnproxy CA certificate into the system trust store (macOS only).
#[tauri::command]
fn install_ca_cert() -> Result<serde_json::Value, String> {
    let home = dirs_home()?;
    let ca_path = format!("{}/.cnproxy/certs/ca.crt", home);

    if !std::path::Path::new(&ca_path).exists() {
        return Err(format!("CA certificate not found at {}", ca_path));
    }

    if cfg!(target_os = "macos") {
        // Requires admin privileges. We try with osascript to get a password prompt.
        let out = std::process::Command::new("osascript")
            .args([
                "-e",
                &format!(
                    "do shell script \"security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {}\" with administrator privileges",
                    ca_path
                ),
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if out.status.success() {
            Ok(serde_json::json!({ "ok": true, "message": "CA certificate installed and trusted" }))
        } else {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // If user cancelled auth, provide a helpful message
            if stderr.contains("-128") || stderr.contains("User canceled") {
                Ok(serde_json::json!({ "ok": false, "message": "Authentication cancelled. You can manually install:\nsudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cnproxy/certs/ca.crt" }))
            } else {
                Err(format!("Failed to install CA: {}", stderr))
            }
        }
    } else if cfg!(target_os = "windows") {
        // Windows: certutil requires admin
        let out = std::process::Command::new("certutil")
            .args(["-addstore", "-f", "Root", &ca_path])
            .output()
            .map_err(|e| e.to_string())?;

        if out.status.success() {
            Ok(serde_json::json!({ "ok": true, "message": "CA certificate installed to Windows trusted root store" }))
        } else {
            Err(format!("Failed to install CA. Try running as administrator:\ncertutil -addstore -f Root {}", ca_path))
        }
    } else if cfg!(target_os = "linux") {
        // Linux: copy to system CA store + update
        let dest = "/usr/local/share/ca-certificates/cnproxy-ca.crt";
        let cp_out = std::process::Command::new("cp")
            .args([&ca_path, dest])
            .output()
            .map_err(|e| e.to_string())?;

        if !cp_out.status.success() {
            return Err(format!("Failed to copy CA cert. Try:\nsudo cp {} {} && sudo update-ca-certificates", ca_path, dest));
        }

        let upd_out = std::process::Command::new("update-ca-certificates")
            .output()
            .map_err(|e| e.to_string())?;

        if upd_out.status.success() {
            Ok(serde_json::json!({ "ok": true, "message": "CA certificate installed to Linux system trust store" }))
        } else {
            Err("Failed to update CA certificates. Try: sudo update-ca-certificates".into())
        }
    } else {
        Err("CA installation not supported on this platform".into())
    }
}

/// Remove the cnproxy CA from the system trust store.
#[tauri::command]
fn uninstall_ca_cert() -> Result<serde_json::Value, String> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("osascript")
            .args([
                "-e",
                "do shell script \"security remove-trusted-cert -d $(security find-certificate -a -p /Library/Keychains/System.keychain | grep -A1 'CNProxy' | head -1 | openssl x509 -noout -fingerprint -sha1 2>/dev/null | cut -d= -f2) /Library/Keychains/System.keychain 2>/dev/null; security delete-certificate -c 'CNProxy Root CA' /Library/Keychains/System.keychain\" with administrator privileges",
            ])
            .output()
            .map_err(|e| e.to_string())?;

        if out.status.success() {
            Ok(serde_json::json!({ "ok": true, "message": "CA certificate removed from system trust store" }))
        } else {
            // Try simpler removal
            let out2 = std::process::Command::new("osascript")
                .args([
                    "-e",
                    "do shell script \"security delete-certificate -c 'CNProxy Root CA' /Library/Keychains/System.keychain\" with administrator privileges",
                ])
                .output()
                .map_err(|e| e.to_string())?;

            if out2.status.success() {
                Ok(serde_json::json!({ "ok": true, "message": "CA certificate removed" }))
            } else {
                Ok(serde_json::json!({ "ok": false, "message": "Could not remove CA. Try:\nsudo security delete-certificate -c 'CNProxy Root CA' /Library/Keychains/System.keychain" }))
            }
        }
    } else {
        Ok(serde_json::json!({ "ok": false, "message": "CA uninstall not yet implemented for this platform" }))
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn dirs_home() -> Result<String, String> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).map_err(|_| "Cannot determine home directory".into())
}

fn run_cmd(cmd: &str, args: &[&str]) {
    let _ = std::process::Command::new(cmd).args(args).output();
}

/// List macOS network services for proxy configuration.
fn network_services_macos() -> Vec<String> {
    let out = std::process::Command::new("networksetup")
        .args(["-listallnetworkservices"])
        .output();

    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .skip(1) // first line is header
                .filter(|l| !l.is_empty() && !l.contains("*")) // skip disabled
                .map(|l| l.trim().to_string())
                .collect()
        }
        _ => vec!["Wi-Fi".into(), "Ethernet".into()], // fallback
    }
}

// ── App entry point ──────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // When a second instance is launched, focus the existing window.
            let _ = app
                .get_webview_window("main")
                .and_then(|w| w.set_focus().ok());
        }))
        .manage(Mutex::new(SidecarState { child: None }))
        .manage(Mutex::new(ProxyState {
            proxy_port: 0,
            web_port: 0,
            system_proxy_on: false,
        }))
        .invoke_handler(tauri::generate_handler![
            get_proxy_ports,
            toggle_system_proxy,
            get_ca_cert_path,
            install_ca_cert,
            uninstall_ca_cert,
        ])
        .setup(|app| {
            let _handle = app.app_handle().clone();

            // ── System tray ──────────────────────────────────────────────
            let show_item = MenuItemBuilder::with_id("show", "Show CNProxy").build(app)?;
            let proxy_item = MenuItemBuilder::with_id("toggle_proxy", "Enable System Proxy").build(app)?;
            let ca_item = MenuItemBuilder::with_id("install_ca", "Install CA Certificate").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit CNProxy").build(app)?;

            let menu = MenuBuilder::new(app)
                .items(&[&show_item, &proxy_item, &ca_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().cloned().expect("icon required"))
                .menu(&menu)
                .tooltip("CNProxy")
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "toggle_proxy" => {
                        let _ = toggle_system_proxy(app.app_handle().clone(), app.state::<Mutex<ProxyState>>());
                        // Update menu label
                        let is_on = app.state::<Mutex<ProxyState>>().lock().unwrap().system_proxy_on;
                        if let Some(tray) = app.tray_by_id("main-tray") {
                            let _label = if is_on { "Disable System Proxy" } else { "Enable System Proxy" };
                            let _ = tray.set_tooltip(Some(&format!("CNProxy — proxy {}", if is_on { "on" } else { "off" })));
                        }
                    }
                    "install_ca" => {
                        let result = install_ca_cert();
                        let msg = match result {
                            Ok(v) => v["message"].as_str().unwrap_or("Done").to_string(),
                            Err(e) => format!("Error: {}", e),
                        };
                        // Show a notification or just log
                        eprintln!("[cnproxy] CA install: {}", msg);
                    }
                    "quit" => {
                        // Turn off system proxy before quitting
                        let is_on = app.state::<Mutex<ProxyState>>().lock().unwrap().system_proxy_on;
                        if is_on {
                            let _ = toggle_system_proxy(app.app_handle().clone(), app.state::<Mutex<ProxyState>>());
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Application menu bar ─────────────────────────────────────
            #[cfg(desktop)]
            {
                let file_menu = SubmenuBuilder::new(app, "File")
                    .text("import-har", "Import HAR…")
                    .text("export-har", "Export HAR…")
                    .separator()
                    .text("preferences", "Preferences…")
                    .separator()
                    .text("quit", "Quit CNProxy")
                    .build()?;

                let edit_menu = SubmenuBuilder::new(app, "Edit")
                    .text("undo", "Undo")
                    .text("redo", "Redo")
                    .separator()
                    .text("cut", "Cut")
                    .text("copy", "Copy")
                    .text("paste", "Paste")
                    .text("select-all", "Select All")
                    .build()?;

                let view_menu = SubmenuBuilder::new(app, "View")
                    .text("reload", "Reload Inspector")
                    .text("toggle-devtools", "Toggle Developer Tools")
                    .separator()
                    .text("zoom-in", "Zoom In")
                    .text("zoom-out", "Zoom Out")
                    .text("zoom-reset", "Reset Zoom")
                    .build()?;

                let window_menu = SubmenuBuilder::new(app, "Window")
                    .text("minimize", "Minimize")
                    .text("zoom", "Zoom")
                    .build()?;

                let help_menu = SubmenuBuilder::new(app, "Help")
                    .text("about", "About CNProxy")
                    .build()?;

                let menubar = MenuBuilder::new(app)
                    .items(&[&file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                    .build()?;

                app.set_menu(menubar)?;

                app.on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => {
                        let is_on = app.state::<Mutex<ProxyState>>().lock().unwrap().system_proxy_on;
                        if is_on {
                            let _ = toggle_system_proxy(app.app_handle().clone(), app.state::<Mutex<ProxyState>>());
                        }
                        app.exit(0);
                    }
                    "reload" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("location.reload()");
                        }
                    }
                    "toggle-devtools" => {
                        if let Some(w) = app.get_webview_window("main") {
                            w.open_devtools();
                        }
                    }
                    "zoom-in" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.body.style.zoom = (parseFloat(document.body.style.zoom || 1) + 0.1).toFixed(1)");
                        }
                    }
                    "zoom-out" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.body.style.zoom = Math.max(0.3, parseFloat(document.body.style.zoom || 1) - 0.1).toFixed(1)");
                        }
                    }
                    "zoom-reset" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.body.style.zoom = '1'");
                        }
                    }
                    "minimize" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.minimize();
                        }
                    }
                    "zoom" => {
                        // macOS Zoom = maximize
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.maximize();
                        }
                    }
                    "import-har" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.getElementById('importHar').click()");
                        }
                    }
                    "export-har" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.eval("document.querySelector('a[href=\"/api/export/har\"]')?.click()");
                        }
                    }
                    "about" => {
                        let version = env!("CARGO_PKG_VERSION");
                        let _ = app.emit("show-about", serde_json::json!({ "version": version }));
                    }
                    _ => {}
                });
            }

            // ── Sidecar spawn ────────────────────────────────────────────
            let handle2 = app.app_handle().clone();
            match app.shell().sidecar("binaries/cnproxy") {
                Ok(sidecar_cmd) => {
                    match sidecar_cmd
                        .args(["--port", "0", "--web-port", "0"])
                        .spawn()
                    {
                        Ok((mut rx, child)) => {
                            app.state::<Mutex<SidecarState>>()
                                .lock()
                                .unwrap()
                                .child = Some(child);

                            tauri::async_runtime::spawn(async move {
                                while let Some(event) = rx.recv().await {
                                    match event {
                                        CommandEvent::Stdout(line) => {
                                            let text = String::from_utf8_lossy(&line);
                                            if let Some(json_str) =
                                                text.strip_prefix("[cnproxy:ready] ")
                                            {
                                                if let Ok(value) =
                                                    serde_json::from_str::<serde_json::Value>(
                                                        json_str.trim(),
                                                    )
                                                {
                                                    // Store ports in shared state
                                                    if let Some(p) = value.get("proxyPort").and_then(|v| v.as_u64()) {
                                                        handle2.state::<Mutex<ProxyState>>().lock().unwrap().proxy_port = p as u16;
                                                    }
                                                    if let Some(w) = value.get("webPort").and_then(|v| v.as_u64()) {
                                                        handle2.state::<Mutex<ProxyState>>().lock().unwrap().web_port = w as u16;
                                                    }
                                                    let _ = handle2.emit("cnproxy-ready", value);
                                                }
                                            }
                                        }
                                        CommandEvent::Stderr(line) => {
                                            eprintln!(
                                                "[cnproxy] {}",
                                                String::from_utf8_lossy(&line)
                                            );
                                        }
                                        CommandEvent::Terminated(status) => {
                                            eprintln!(
                                                "[cnproxy] sidecar terminated: {:?}",
                                                status
                                            );
                                            break;
                                        }
                                        _ => {}
                                    }
                                }
                            });
                        }
                        Err(e) => {
                            eprintln!("[cnproxy] failed to spawn sidecar: {}", e);
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[cnproxy] sidecar not available: {}", e);
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Turn off system proxy if we enabled it
            let is_on = handle.state::<Mutex<ProxyState>>().lock().unwrap().system_proxy_on;
            if is_on {
                let _ = toggle_system_proxy(handle.clone(), handle.state::<Mutex<ProxyState>>());
            }
            // Kill the sidecar
            if let Some(state) = handle.try_state::<Mutex<SidecarState>>() {
                if let Ok(mut s) = state.lock() {
                    if let Some(child) = s.child.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}