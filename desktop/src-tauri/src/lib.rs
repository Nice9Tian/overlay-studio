use tauri::{
    menu::{MenuBuilder, SubmenuBuilder},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// 把一段中文提示安全地写进等待页的 #status。
/// 为什么不用 format! 直接拼 JS 字符串？
/// 答：日志路径里可能出现单引号(账户名 O'Brien 之类)、反斜杠和非 ASCII 字符，
/// 手工转义漏一个整段 eval 就是语法错误、静默不执行，恰好在最需要诊断信息的机器上失效。
/// serde_json::to_string 生成的是合法的 JS 字符串字面量，所有情况一次处理干净。
/// 为什么还要 setTimeout 轮询？
/// 答：sidecar 可能在等待页 DOM 还没解析完时就秒退，这时 getElementById 拿到 null，
/// 提示会丢。轮询到元素出现为止，保证用户一定看得到失败原因。
fn status_eval_script(message: &str) -> String {
    let literal = serde_json::to_string(message).unwrap_or_else(|_| "\"启动失败\"".to_string());
    format!(
        "(function(){{var m={};function w(){{var e=document.getElementById('status');\
         if(e){{e.innerText=m;}}else{{setTimeout(w,100);}}}}w();}})()",
        literal
    )
}

/// 原生消息框。为什么不用 tauri-plugin-dialog？
/// 答：那个插件会往每个页面注入脚本，把 window.alert / window.confirm 换成走 IPC 的异步版本。
/// 编辑台是远程地址(localhost:5177)，IPC 被 ACL 拒掉，alert 一个都弹不出来 —— 导出完成的
/// 文件清单、导入失败的原因全都静默消失(2026-09-06 实测，日志里是一串
/// 「plugin:dialog|message not allowed by ACL」)。就算放行 ACL 也不行：confirm 变成异步后，
/// 页面里 `if (!confirm(...)) return` 这种同步守卫永远不拦(Promise 恒为真)，「清空编排」会
/// 不经确认直接执行。去掉插件，WebView2 自带的同步 alert / confirm 照常工作；Rust 这边的
/// 几个提示框直接用 rfd(插件底下用的也是它)。
fn native_message(title: &str, message: &str, level: rfd::MessageLevel) {
    let _ = rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_level(level)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// 编辑台地址。为什么写 127.0.0.1 而不是 localhost？
/// 答：sidecar 只监听 IPv4 的 127.0.0.1:5177；而 localhost 在 WebView2 里可能先解析成 IPv6 的 ::1，
/// 只要本机有别的程序(比如开发期另起的 vite)恰好监听 [::1]:5177，窗口就会连到错的服务上去，
/// 界面看着一样、导出却跑在别处。就绪探测和端口检查本来就用 127.0.0.1，这里保持一致。
const EDITOR_URL: &str = "http://127.0.0.1:5177/";

fn get_runtime_dir(app: &AppHandle) -> PathBuf {
    // 为什么 runtime 目录允许被环境变量覆盖？
    // 答：为了在开发期间免得每次运行都复制 800MB 的 motion-playground 和无头浏览器，极大提升开发效率。
    if let Ok(dir) = env::var("OVERLAY_RUNTIME_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    // 否则用 app.path().resource_dir() 拼上 runtime 子目录
    app.path().resource_dir().unwrap_or_default().join("runtime")
}

pub fn run() {
    let app_builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                // 第二次启动不再开窗,只把已有窗口 unminimize + show + set_focus
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }),
        )
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            let mut is_existing_instance = false;
            // 端口检查: 启动时先试 TcpStream 连 127.0.0.1:5177
            if let Ok(mut stream) = TcpStream::connect("127.0.0.1:5177") {
                let port_busy = || {
                    native_message(
                        "端口被占用",
                        "端口 5177 被别的程序占用，请关掉它再启动。",
                        rfd::MessageLevel::Error,
                    );
                    std::process::exit(1);
                };

                // 连得上就发一个 GET /
                let request = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
                if stream.write_all(request.as_bytes()).is_ok() {
                    let mut response = String::new();
                    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap_or_default();
                    if stream.read_to_string(&mut response).is_ok() {
                        if response.contains("Overlay Studio") {
                            // 响应体里含 Overlay Studio 字样就认为是已有实例, 跳过 sidecar 直接开窗导航
                            is_existing_instance = true;
                        } else {
                            port_busy();
                        }
                    } else {
                        port_busy();
                    }
                } else {
                    // write_all 失败(例如对端拒绝服务)也视为端口被非期望程序占用
                    port_busy();
                }
            }

            let opener_handle = handle.clone();
            let opener_nw = handle.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Overlay Studio")
                .inner_size(1600.0, 960.0)
                .min_inner_size(1200.0, 720.0)
                .center()
                .maximizable(true)
                .on_navigation(move |url| {
                    let host = url.host_str().unwrap_or("");
                    // 原因：等待页(tauri.localhost)和Vite(localhost)都需要放行，否则会导致等待页被外部浏览器拦截
                    if host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost") {
                        return true;
                    }
                    if url.scheme() == "http" || url.scheme() == "https" {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = opener_handle.opener().open_url(url.as_str(), None::<&str>);
                        return false;
                    }
                    true
                })
                .on_new_window(move |url, _features| {
                    // 原因：原生 target="_blank" 会触发 new_window 事件而不走 on_navigation，这里拦截交给外部浏览器打开，避免在当前 WebView 跳转
                    if url.scheme() == "http" || url.scheme() == "https" {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = opener_nw.opener().open_url(url.as_str(), None::<&str>);
                    }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;

            // 原生菜单 (tauri::menu)
            let file_menu = SubmenuBuilder::with_id(&handle, "file", "文件")
                .text("open-export", "打开导出成品文件夹")
                .text("open-fonts", "打开字体文件夹")
                .text("open-media", "打开素材文件夹")
                .separator()
                .text("quit", "退出")
                .build()?;
            let help_menu = SubmenuBuilder::with_id(&handle, "help", "帮助")
                .text("open-logs", "查看运行日志")
                .text("about", "关于")
                .build()?;
            let menu = MenuBuilder::new(&handle).items(&[&file_menu, &help_menu]).build()?;
            app.set_menu(menu)?;
            
            let runtime_dir = get_runtime_dir(&handle);
            let app_log_dir = handle.path().app_log_dir().unwrap_or_default();
            let _ = fs::create_dir_all(&app_log_dir);
            let export_dir = PathBuf::from(&env::var("USERPROFILE").unwrap_or_default()).join("Videos").join("Overlay Studio");

            let runtime_dir_for_menu = runtime_dir.clone();
            let app_log_dir_for_menu = app_log_dir.clone();
            let export_dir_for_menu = export_dir.clone();

            app.on_menu_event(move |app_handle, event| {
                match event.id().as_ref() {
                    "open-export" => {
                        let dir = export_dir_for_menu.join("output");
                        let _ = fs::create_dir_all(&dir);
                        let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
                    }
                    "open-fonts" => {
                        let dir = runtime_dir_for_menu.join("app").join("src").join("assets").join("fonts");
                        let _ = fs::create_dir_all(&dir);
                        let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
                    }
                    "open-media" => {
                        let dir = runtime_dir_for_menu.join("app").join("public").join("_media");
                        let _ = fs::create_dir_all(&dir);
                        let _ = std::process::Command::new("explorer.exe").arg(&dir).spawn();
                    }
                    "quit" => {
                        app_handle.exit(0);
                    }
                    "open-logs" => {
                        let _ = fs::create_dir_all(&app_log_dir_for_menu);
                        let _ = std::process::Command::new("explorer.exe").arg(&app_log_dir_for_menu).spawn();
                    }
                    "about" => {
                        let versions_path = runtime_dir_for_menu.join("VERSIONS.json");
                        let mut versions_info = String::from("未知");
                        if let Ok(content) = fs::read_to_string(&versions_path) {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                                versions_info = format!(
                                    "App: {}\nNode: {}\nChrome: {}\nFFmpeg: {}",
                                    json.get("app").and_then(|v| v.as_str()).unwrap_or("未知"),
                                    json.get("node").and_then(|v| v.as_str()).unwrap_or("未知"),
                                    json.get("chrome").and_then(|v| v.as_str()).unwrap_or("未知"),
                                    json.get("ffmpeg").and_then(|v| v.as_str()).unwrap_or("未知")
                                );
                            }
                        }
                        
                        let msg = format!("Overlay Studio 壳版本: {}\n\n{}", app_handle.package_info().version, versions_info);
                        native_message("关于 Overlay Studio", &msg, rfd::MessageLevel::Info);
                    }
                    _ => {}
                }
            });

            if is_existing_instance {
                let _ = window.navigate(tauri::Url::parse(EDITOR_URL).unwrap());
                return Ok(());
            }

            let app_dir = runtime_dir.join("app");
            let chrome_dir = runtime_dir.join("chrome");
            let ffmpeg_dir = runtime_dir.join("ffmpeg");
            let log_file_path = app_log_dir.join("sidecar.log");

            // 为什么 Command::env 之前要重建完整环境表？
            // 答：Tauri 的 Command::env_clear().envs() 方式或环境变量替换会把子进程继承的环境变量整个换掉。
            // 如果不把当前进程的环境变量表整份拷过来再覆盖，node 就会丢失 SystemRoot、TEMP 等 Windows 必需的关键变量，导致启动或运行各种异常。
            let mut envs: std::collections::HashMap<String, String> = env::vars().collect();
            // 原因：Windows 环境块中路径变量名为首字母大写的 Path，而 std 用大小写不敏感的 EnvKey 合并。
            // 如果这里强制用 PATH，同时存在两个键时取值会随 HashMap 迭代顺序变化，导致子进程随机丢失原环境 PATH 变量。
            // 故按原键名找回来、按原键名写回去。
            let path_key = envs.keys().find(|k| k.eq_ignore_ascii_case("PATH")).cloned()
                .unwrap_or_else(|| "PATH".to_string());
            let old_path = envs.get(&path_key).cloned().unwrap_or_default();

            let mut new_path = std::ffi::OsString::new();
            new_path.push(ffmpeg_dir.as_os_str());
            new_path.push(";");
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    new_path.push(exe_dir.as_os_str());
                    new_path.push(";");
                }
            }
            new_path.push(&old_path);
            envs.insert(path_key, new_path.to_string_lossy().to_string());

            envs.insert("PUPPETEER_CACHE_DIR".to_string(), chrome_dir.to_string_lossy().to_string());
            envs.insert("BROWSER".to_string(), "none".to_string());
            envs.insert("OVERLAY_EXPORT_DIR".to_string(), export_dir.to_string_lossy().to_string());

            // 导出走静态模式:让 export-frames.mjs 从 runtime/app/dist 里读页面，而不是去连 Vite。
            // 为什么？
            // 答：导出页(?export=1)不调任何 /api/，本来就不需要后端；指了这个目录之后，
            // puppeteer 用请求拦截把 overlay.local 的请求映射到 dist 和 public 上的文件，
            // 再配合 CDP 管道(--remote-debugging-pipe)，导出全程不占任何端口 ——
            // 用户在编辑台里点导出时，Chrome 不会再跟 5177 上的 Vite 抢连接，
            // 命令行版单独跑导出时也不必先起服务器。dist 由 prepare-runtime.mjs 构建并断言存在。
            // 只在 dist 真的在的时候才写这个变量。
            // 为什么要判断？
            // 答：export-frames.mjs 对 OVERLAY_EXPORT_STATIC_DIR 是硬失败 —— 目录里没有 index.html
            // 就直接退出 1，而不是退回服务器模式。正常安装包里 dist 一定在(prepare-runtime 会断言)，
            // 但开发期用 OVERLAY_RUNTIME_DIR 指到一个老 runtime、或者用户手上是升级前的 runtime 目录时，
            // 无条件写入会让每一次导出都失败，而且脚本给的提示是「去 motion-playground 跑 vite build」，
            // 对桌面版用户是错误指引。缺了就干脆不设：导出退回服务器模式(要占 5177，但能出片)。
            let static_dir = app_dir.join("dist");
            if static_dir.join("index.html").is_file() {
                envs.insert(
                    "OVERLAY_EXPORT_STATIC_DIR".to_string(),
                    static_dir.to_string_lossy().to_string(),
                );
            } else {
                eprintln!(
                    "[overlay] {} 不存在，导出退回服务器模式；重跑 desktop 的 npm run prepare-runtime 可恢复静态模式",
                    static_dir.join("index.html").display()
                );
            }
            // 并行导出的工作器数量交给脚本自己算(auto)。
            // 为什么不写死一个数？
            // 答：装了这个壳的机器配置差得很远(4 核笔记本到 32 核台式)，写死要么跑不满、要么把内存吃爆。
            // auto 会按 CPU 核数和空闲内存估上限，再实测前几十帧的耗时来决定开几个浏览器，
            // 帧数太少(<300)或估出来只能开 1 个时就退回原来的单进程循环，逐帧结果完全一致。
            envs.insert("OVERLAY_EXPORT_WORKERS".to_string(), "auto".to_string());

            // 起 sidecar(node)
            // 原因：打包 release 版本没有控制台，直接 expect 会静默闪退，改成 match 配合对话框弹出能给用户明确提示
            let command_res = handle.shell().sidecar("node");
            let command = match command_res {
                Ok(c) => c,
                Err(e) => {
                    native_message(
                        "Overlay Studio 启动失败",
                        &format!("无法创建内置 Node 命令，请重新安装。\n{}", e),
                        rfd::MessageLevel::Error,
                    );
                    std::process::exit(1);
                }
            };
            let command = command
                .args(["node_modules/vite/bin/vite.js", "--port", "5177", "--strictPort", "--host", "127.0.0.1"])
                .current_dir(&app_dir)
                .env_clear()
                .envs(envs);

            let (mut rx, child) = match command.spawn() {
                Ok(res) => res,
                Err(e) => {
                    native_message(
                        "Overlay Studio 启动失败",
                        &format!("无法启动内置 Node，请重新安装。\n{}", e),
                        rfd::MessageLevel::Error,
                    );
                    std::process::exit(1);
                }
            };
            let child_pid = child.pid();

            handle.manage(SidecarPid(Mutex::new(Some(child_pid))));

            use std::sync::atomic::{AtomicBool, Ordering};
            use std::sync::Arc;
            // 为什么要这个标志？
            // 答：sidecar 秒退时 Terminated 事件已经拿到确切退出码并写进了 #status，
            // 如果不让轮询线程提前退出，它会一路轮到 90 秒再把 #status 覆盖成笼统的「启动超时」，
            // 反而把确切的失败原因盖掉。
            let sidecar_dead = Arc::new(AtomicBool::new(false));
            let sidecar_dead_for_log = sidecar_dead.clone();

            let log_file_path_clone = log_file_path.clone();
            let log_path_for_log = log_file_path.clone();
            let window_for_log = window.clone();
            tauri::async_runtime::spawn(async move {
                let mut file = OpenOptions::new().create(true).append(true).open(&log_file_path_clone).ok();
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                            if let Some(f) = file.as_mut() {
                                let _ = writeln!(f, "{}", String::from_utf8_lossy(&line));
                            }
                        }
                        CommandEvent::Terminated(payload) => {
                            let code_text = payload
                                .code
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "未知".to_string());
                            let msg = format!(
                                "Node 已退出(code={})，请查看日志: {}",
                                code_text,
                                log_path_for_log.display()
                            );
                            // 先置标志再 eval，保证轮询线程不会在这之后又把提示覆盖掉
                            sidecar_dead_for_log.store(true, Ordering::SeqCst);
                            let _ = window_for_log.eval(&status_eval_script(&msg));
                        }
                        _ => {}
                    }
                }
            });

            let window_clone = window.clone();
            let log_path_for_poll = log_file_path.clone();
            
            thread::spawn(move || {
                let start_time = std::time::Instant::now();
                loop {
                    // sidecar 已经退出，退出码提示已经写进 #status，不要再等到 90 秒去覆盖它
                    if sidecar_dead.load(Ordering::SeqCst) {
                        break;
                    }
                    if start_time.elapsed() > Duration::from_secs(90) {
                        let msg = format!("启动超时，请查看日志: {}", log_path_for_poll.display());
                        let _ = window_clone.eval(&status_eval_script(&msg));
                        break;
                    }

                    thread::sleep(Duration::from_millis(250));
                    
                    if let Ok(mut stream) = TcpStream::connect("127.0.0.1:5177") {
                        // 为什么就绪判断要先 TCP 探通再 GET / 拿到 200 才 navigate？
                        // 答：因为 Vite 端口会先监听，但此时模块还没编译完或服务还没完全准备好。
                        // 过早跳转会导致前端直接报错或白屏。必须等 GET / 返回 200，说明不仅端口通了，HTTP 服务也完全就绪了。
                        let request = "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
                        if stream.write_all(request.as_bytes()).is_ok() {
                            let mut response = String::new();
                            stream.set_read_timeout(Some(Duration::from_millis(500))).unwrap_or_default();
                            if stream.read_to_string(&mut response).is_ok() {
                                if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
                                    let _ = window_clone.navigate(tauri::Url::parse(EDITOR_URL).unwrap());
                                    break;
                                }
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app_builder.run(|app_handle, e| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = e {
            // 退出时: 为什么要带 /T？
            // 答：如果不带 /T，仅仅结束 sidecar node 进程，由于导出任务时 node 还会启动 puppeteer
            // (即 Chrome for Testing 进程)，导致这个 Chrome 进程作为残留僵尸进程留在系统里。
            // 加上 /T 可以终结该进程树上的所有子进程，彻底释放资源。
            if let Some(state) = app_handle.try_state::<SidecarPid>() {
                if let Ok(mut pid_guard) = state.0.lock() {
                    if let Some(pid) = pid_guard.take() {
                        let mut cmd = std::process::Command::new("taskkill");
                        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
                        
                        #[cfg(target_os = "windows")]
                        cmd.creation_flags(0x08000000);
                        
                        let _ = cmd.status(); // 原因：等待杀进程结束，避免因为并发退出导致 node.exe 和 chrome.exe 残留，导致验收偶然不通过
                    }
                }
            }
        }
    });
}

struct SidecarPid(Mutex<Option<u32>>);
