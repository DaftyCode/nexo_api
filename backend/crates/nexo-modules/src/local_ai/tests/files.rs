//! Archives opened inside their folder, a GGUF of one's own, and removing everything.
use super::*;
use nexo_application::ports::LocalModel;
use std::io::Write;

#[test]
fn archives_open_inside_their_folder() {
    let folder = std::env::temp_dir().join(format!("nexo-unpack-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    let zip_path = folder.join("engine.zip");
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file(
            format!("bin/llama-server{}", std::env::consts::EXE_SUFFIX),
            options,
        )
        .unwrap();
        zip.write_all(b"server").unwrap();
        zip.finish().unwrap();
    }
    let into = folder.join("engine");
    unpack::unpack(&zip_path, &into).unwrap();
    assert!(
        unpack::server_in(&into)
            .unwrap()
            .ends_with(format!("llama-server{}", std::env::consts::EXE_SUFFIX))
    );

    let evil = folder.join("evil.zip");
    {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&evil).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("../escaped.txt", options).unwrap();
        zip.write_all(b"x").unwrap();
        zip.finish().unwrap();
    }
    assert!(unpack::unpack(&evil, &folder.join("other")).is_err());
    assert!(!folder.join("escaped.txt").exists());

    let tar_path = folder.join("engine.tar.gz");
    {
        let gz = flate2::write::GzEncoder::new(
            std::fs::File::create(&tar_path).unwrap(),
            flate2::Compression::fast(),
        );
        let mut tar = tar::Builder::new(gz);
        let mut header = tar::Header::new_gnu();
        header.set_size(6);
        header.set_mode(0o755);
        header.set_cksum();
        tar.append_data(&mut header, "build/bin/llama-server", &b"server"[..])
            .unwrap();
        tar.into_inner().unwrap().finish().unwrap();
    }
    let from_tar = folder.join("from-tar");
    unpack::unpack(&tar_path, &from_tar).unwrap();
    assert!(from_tar.join("build/bin/llama-server").is_file());
    assert!(unpack::unpack(&folder.join("engine.rar"), &folder).is_err());
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn a_gguf_of_ones_own_replaces_the_download_and_everything_can_be_removed() {
    let root = std::env::temp_dir().join(format!("nexo-ai-{}", uuid::Uuid::new_v4()));
    let models = LocalModels::new(root.clone(), Arc::new(Open), Arc::new(Fake)).unwrap();
    let status = models.status().await.unwrap();
    assert!(!status.engine && status.model.is_none());
    assert_eq!(status.backend, "vulkan");
    assert_eq!(status.engine_size, 38_935_891);
    assert_eq!(status.recommended.as_deref(), Some("qwen3.5-4b"));
    assert!(
        models
            .endpoint()
            .await
            .unwrap_err()
            .to_string()
            .contains("Download the local model")
    );
    assert!(models.install(Some("llama".into())).await.is_err());

    // An engine already there, so choosing a file downloads nothing.
    let engine = root.join("engine").join("b12641-vulkan");
    std::fs::create_dir_all(&engine).unwrap();
    std::fs::write(
        engine.join(format!("llama-server{}", std::env::consts::EXE_SUFFIX)),
        b"",
    )
    .unwrap();
    std::fs::write(
        root.join("engine").join("installed.json"),
        r#"{"backend":"vulkan","folder":"b12641-vulkan"}"#,
    )
    .unwrap();
    std::fs::create_dir_all(root.join("models")).unwrap();
    std::fs::write(root.join("models").join("old.gguf"), b"GGUF").unwrap();
    let own = root.join("mine.gguf");
    std::fs::write(&own, b"GGUF and the rest").unwrap();
    let status = models.use_file(own.display().to_string()).await.unwrap();
    assert!(status.engine);
    assert_eq!(
        (status.model.as_deref(), status.model_name.as_deref()),
        (Some("file"), Some("mine.gguf"))
    );
    assert!(!root.join("models").exists(), "one model at a time");
    let text = root.join("notes.gguf");
    std::fs::write(&text, b"plain").unwrap();
    assert!(models.use_file(text.display().to_string()).await.is_err());
    assert!(
        models
            .use_file(root.join("absent.gguf").display().to_string())
            .await
            .is_err()
    );

    let status = models.remove().await.unwrap();
    assert!(!status.engine && status.model.is_none());
    assert!(!root.join("engine").exists());
    std::fs::remove_dir_all(root).unwrap();
}
