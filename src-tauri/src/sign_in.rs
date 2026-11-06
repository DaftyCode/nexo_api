//! OAuth 2.0 sign-in in a window of the app, as Postman does: the provider's pages load in
//! it and, when they send it to the Callback URL, that navigation is stopped and its address
//! (with the code or token) is returned. Any Callback URL works, also one that belongs to
//! another web application, which never receives the code.
//!
//! The window shows remote pages only: it has no capability (they are granted to `main`), so
//! those pages cannot call the app. Its cookies are kept, so the provider remembers the
//! session the next time, like a browser.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// How a sign-in window ended.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "lowercase")]
pub enum Outcome {
    /// It reached the Callback URL; `url` is the full address.
    Returned { url: String },
    /// The person closed it.
    Closed,
    /// Another sign-in window took its place.
    Replaced,
}

/// The sign-in window that is open: its label and the sender that ends its call. Each window
/// gets its own label, because closing one is not immediate and a new one may open meanwhile.
#[derive(Default)]
pub struct Current(Mutex<Option<(String, tauri::async_runtime::Sender<Outcome>)>>);
impl Current {
    fn replace(
        &self,
        next: Option<(String, tauri::async_runtime::Sender<Outcome>)>,
    ) -> Option<(String, tauri::async_runtime::Sender<Outcome>)> {
        let mut current = self.0.lock().unwrap_or_else(|error| error.into_inner());
        std::mem::replace(&mut *current, next)
    }
}

fn destroy(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

/// Whether `address` is the Callback URL: same scheme, host, port and path. The query and
/// the fragment are what the provider adds.
fn is_callback(address: &Url, callback: &Url) -> bool {
    address.scheme() == callback.scheme()
        && address.host_str() == callback.host_str()
        && address.port_or_known_default() == callback.port_or_known_default()
        && address.path().trim_end_matches('/') == callback.path().trim_end_matches('/')
}

fn web_address(text: &str, what: &str) -> Result<Url, String> {
    Url::parse(text)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .ok_or_else(|| format!("The {what} must be an http or https address"))
}

/// Opens the sign-in page in a window and waits until it reaches the Callback URL, the
/// person closes it or another sign-in replaces it.
#[tauri::command]
pub async fn oauth2_sign_in_window(
    app: AppHandle,
    current: tauri::State<'_, Current>,
    url: String,
    callback: String,
) -> Result<Outcome, String> {
    let url = web_address(&url, "sign-in page")?;
    let callback = web_address(&callback, "Callback URL")?;
    let label = format!("oauth2-sign-in-{}", uuid::Uuid::new_v4().simple());
    let (sender, mut receiver) = tauri::async_runtime::channel::<Outcome>(1);
    if let Some((previous, ended)) = current.replace(Some((label.clone(), sender.clone()))) {
        let _ = ended.try_send(Outcome::Replaced);
        destroy(&app, &previous);
    }
    let returned = sender.clone();
    let handle = app.clone();
    let own = label.clone();
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("Nexo API · Sign in")
        .inner_size(520.0, 740.0)
        .center()
        .on_navigation(move |next| {
            if !is_callback(next, &callback) {
                return true;
            }
            let _ = returned.try_send(Outcome::Returned {
                url: next.to_string(),
            });
            let (handle, own) = (handle.clone(), own.clone());
            tauri::async_runtime::spawn(async move { destroy(&handle, &own) });
            // The Callback URL is not loaded: the code is only for Nexo.
            false
        })
        .build()
        .map_err(|error| format!("The sign-in window could not be opened: {error}"))?;
    let closed = sender;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let _ = closed.try_send(Outcome::Closed);
        }
    });
    let outcome = receiver.recv().await.unwrap_or(Outcome::Closed);
    // Forget this window unless another one already took its place.
    let mut slot = current.0.lock().unwrap_or_else(|error| error.into_inner());
    if slot.as_ref().is_some_and(|(open, _)| *open == label) {
        *slot = None;
    }
    Ok(outcome)
}

/// Closes the sign-in window, when the sign-in ends another way (cancelled, or the address
/// pasted by hand). Its `oauth2_sign_in_window` call ends as `closed`.
#[tauri::command]
pub async fn oauth2_sign_in_window_close(
    app: AppHandle,
    current: tauri::State<'_, Current>,
) -> Result<(), String> {
    let open = current
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|(label, _)| label.clone());
    if let Some(label) = open {
        destroy(&app, &label);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_callback_url_with_what_the_provider_adds() {
        let callback = Url::parse("https://front.example.com/auth/callback").unwrap();
        for address in [
            "https://front.example.com/auth/callback?code=abc&state=1",
            "https://front.example.com/auth/callback/?code=abc",
            "https://front.example.com:443/auth/callback#access_token=t",
            "https://FRONT.example.com/auth/callback?error=access_denied",
        ] {
            assert!(
                is_callback(&Url::parse(address).unwrap(), &callback),
                "{address}"
            );
        }
        for address in [
            "https://login.example.com/authorize?redirect_uri=https://front.example.com/auth/callback",
            "https://front.example.com/auth/callback-other",
            "https://front.example.com/auth",
            "http://front.example.com/auth/callback?code=abc",
            "https://front.example.com:8443/auth/callback?code=abc",
            "https://evil.test/auth/callback?code=abc",
        ] {
            assert!(
                !is_callback(&Url::parse(address).unwrap(), &callback),
                "{address}"
            );
        }
    }

    #[test]
    fn only_web_addresses_are_opened() {
        assert!(web_address("https://login.example.com/authorize", "page").is_ok());
        for address in [
            "file:///C:/secret.txt",
            "javascript:alert(1)",
            "tauri://localhost",
            "nonsense",
        ] {
            assert!(web_address(address, "page").is_err(), "{address}");
        }
    }
}
