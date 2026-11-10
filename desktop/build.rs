fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "save_export",
            "pick_folder",
            "open_external",
            "set_fullscreen",
            "desktop_ready",
            "desktop_smoke",
            "desktop_stage",
        ]),
    ))
    .expect("failed to build desktop context");
}
