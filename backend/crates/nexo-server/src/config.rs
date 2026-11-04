//! Configuration of the local web launcher, from arguments and environment variables.
use crate::{Config, Mode, default_data_dir, random_token};
use std::path::{Path, PathBuf};

pub const HELP: &str = "Nexo API — local web version

  nexo-server [--port N] [--data DIR] [--web DIR] [--no-open]

Starts Nexo on this computer and opens it in your browser. When it is already running,
it opens a new browser session instead.

  --port N      Port on 127.0.0.1 (default 4000, or NEXO_PORT)
  --data DIR    Data directory (default: the desktop app's, or NEXO_DATA_DIR)
  --web DIR     Built web interface (default: next to the executable, or NEXO_WEB_DIR)
  --no-open     Print the sign-in link instead of opening the browser
  --api-only    Serve only the API (development with `ng serve`)";

/// Launcher options resolved from the command line and the environment.
#[derive(Debug)]
pub struct Launch {
    pub config: Config,
    pub port: u16,
    pub open: bool,
}

pub fn parse(
    args: &[String],
    get: impl Fn(&str) -> Option<String>,
    executable: &Path,
) -> Result<Launch, String> {
    let value = |name: &str| {
        get(name)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let flag = |name: &str| -> Result<Option<String>, String> {
        match args.iter().position(|arg| arg == name) {
            Some(index) => args
                .get(index + 1)
                .filter(|v| !v.starts_with("--"))
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("{name} needs a value")),
            None => Ok(None),
        }
    };
    for arg in args.iter().filter(|a| a.starts_with("--")) {
        if ![
            "--port",
            "--data",
            "--web",
            "--no-open",
            "--api-only",
            "--help",
        ]
        .contains(&arg.as_str())
        {
            return Err(format!("Unknown option {arg}\n\n{HELP}"));
        }
    }
    let port = match flag("--port")?.or_else(|| value("NEXO_PORT")) {
        Some(port) => port
            .parse::<u16>()
            .map_err(|_| format!("The port must be a number between 0 and 65535, not {port}"))?,
        None => 4000,
    };
    let directory = executable.parent().unwrap_or(Path::new("."));
    let existing = |candidates: Vec<PathBuf>| candidates.into_iter().find(|path| path.exists());
    let web_root = if args.iter().any(|a| a == "--api-only") {
        None
    } else {
        let explicit = flag("--web")?
            .or_else(|| value("NEXO_WEB_DIR"))
            .map(PathBuf::from);
        let root = explicit.or_else(|| {
            existing(vec![
                directory.join("web"),
                PathBuf::from("dist/nexo/browser"),
                PathBuf::from("dist/desktop/browser"),
            ])
        });
        match root {
            Some(root) if root.join("index.html").exists() => Some(root),
            Some(root) => {
                return Err(format!(
                    "The web interface was not found in {}. Build it with `npm run build`.",
                    root.display()
                ));
            }
            None => {
                return Err(
                    "The web interface was not found. Build it with `npm run build` or pass --web DIR."
                        .into(),
                );
            }
        }
    };
    let master_key = value("NEXO_MASTER_KEY");
    if let Some(key) = &master_key
        && (key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err("NEXO_MASTER_KEY must be 64 hexadecimal characters".into());
    }
    let origins: Vec<String> = value("NEXO_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(|origin| origin.trim().trim_end_matches('/').to_string())
        .filter(|origin| !origin.is_empty())
        .collect();
    if let Some(origin) = origins.iter().find(|origin| {
        !(origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:"))
    }) {
        return Err(format!(
            "NEXO_ORIGINS only accepts local origins, not {origin}"
        ));
    }
    Ok(Launch {
        config: Config {
            data: flag("--data")?
                .or_else(|| value("NEXO_DATA_DIR"))
                .map(PathBuf::from)
                .unwrap_or_else(default_data_dir),
            mode: Mode::Web,
            token: value("NEXO_LOCAL_TOKEN").unwrap_or_else(random_token),
            origins,
            web_root,
            master_key,
        },
        port,
        open: !args.iter().any(|a| a == "--no-open" || a == "--api-only"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    fn launch(args: &[&str], env: &[(&str, &str)]) -> Result<Launch, String> {
        let web = std::env::temp_dir().join(format!("nexo-web-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("index.html"), "<app-root></app-root>").unwrap();
        let map: HashMap<String, String> = env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let mut args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        if !args.iter().any(|a| a == "--web" || a == "--api-only") {
            args.extend(["--web".into(), web.display().to_string()]);
        }
        parse(
            &args,
            |name| map.get(name).cloned(),
            Path::new("/opt/nexo/nexo-server"),
        )
    }
    #[test]
    fn defaults_to_port_4000_and_opens_the_browser() {
        let launch = launch(&[], &[]).unwrap();
        assert_eq!(launch.port, 4000);
        assert!(launch.open);
        assert_eq!(launch.config.mode, Mode::Web);
        assert_eq!(launch.config.token.len(), 64);
    }
    #[test]
    fn reads_options_and_environment() {
        let launch = launch(
            &["--port", "4567", "--no-open", "--data", "/tmp/nexo"],
            &[("NEXO_LOCAL_TOKEN", "fixed")],
        )
        .unwrap();
        assert_eq!(launch.port, 4567);
        assert!(!launch.open);
        assert_eq!(launch.config.data, PathBuf::from("/tmp/nexo"));
        assert_eq!(launch.config.token, "fixed");
    }
    #[test]
    fn api_only_serves_no_files() {
        let launch = launch(&["--api-only"], &[]).unwrap();
        assert!(launch.config.web_root.is_none());
        assert!(!launch.open);
    }
    #[test]
    fn rejects_invalid_values() {
        assert!(launch(&["--port", "x"], &[]).is_err());
        assert!(launch(&["--port"], &[]).is_err());
        assert!(launch(&["--bogus"], &[]).is_err());
        assert!(launch(&[], &[("NEXO_MASTER_KEY", "short")]).is_err());
        assert!(launch(&[], &[("NEXO_ORIGINS", "https://example.com")]).is_err());
        assert!(launch(&["--web", "/missing"], &[]).is_err());
    }
}
