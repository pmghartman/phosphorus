fn main() {
    // the app's commands, each allowed by name in a capability
    let cmds = &["set_domain", "notify", "claude_setup", "client_update_check", "client_update"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(cmds))).expect("tauri build")
}
