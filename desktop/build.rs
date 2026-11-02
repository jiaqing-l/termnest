fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "save_export",
            "open_external",
            "desktop_ready",
            "desktop_smoke",
            "desktop_stage",
        ]),
    ))
    .expect("failed to build desktop context");
}
