//! Code that sends a request, in the languages of `LANGUAGES`.
use super::*;

pub(super) const LANGUAGES: [(&str, &str); 9] = [
    ("cURL", "cURL"),
    ("JavaScript", "Fetch"),
    ("NodeJs", "Fetch"),
    ("Python", "http.client"),
    ("Java", "HttpClient"),
    ("Go", "Native"),
    ("Rust", "reqwest"),
    ("C#", "HttpClient"),
    ("PowerShell", "RestMethod"),
];

/// Headers in insertion order where a later value replaces an earlier one with the same name.
#[derive(Default)]
pub(super) struct Headers(pub(super) Vec<(String, String)>);
impl Headers {
    pub(super) fn set(&mut self, key: &str, value: String) {
        match self.0.iter_mut().find(|(name, _)| name == key) {
            Some(entry) => entry.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }
    pub(super) fn set_default(&mut self, key: &str, value: &str) {
        if !self.0.iter().any(|(name, _)| name == key) {
            self.0.push((key.to_string(), value.to_string()));
        }
    }
}
pub(super) fn quote(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}
pub(super) fn shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
pub(super) fn rust(value: &str) -> String {
    let mut output = String::from("\"");
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            c if c.is_control() => output.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => output.push(c),
        }
    }
    output.push('"');
    output
}
pub(super) fn powershell(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn generate(payload: &Value) -> Result<Value> {
    if payload
        .get("languages")
        .is_some_and(|v| !v.is_null() && v != false)
    {
        return Ok(Value::Array(
            LANGUAGES
                .iter()
                .map(|(key, variant)| json!({"key": key, "label": key, "variants": [{"key": variant, "label": variant}]}))
                .collect(),
        ));
    }
    let request = request_item(&payload["request"])?["request"].clone();
    let mut url = request_url(&request["url"]);
    let method = request["method"].as_str().unwrap_or("GET").to_string();
    let mut headers = Headers::default();
    for header in request["header"].as_array().into_iter().flatten() {
        if header["disabled"] == true || header["enabled"] == false {
            continue;
        }
        if let Some(key) = header["key"].as_str().filter(|key| !key.is_empty()) {
            headers.set(key, js_string(&header["value"]));
        }
    }
    let auth = auth_values(&request["auth"]);
    let get = |key: &str| auth.get(key).map(js_string).unwrap_or_default();
    match request["auth"]["type"].as_str() {
        Some("basic") => headers.set(
            "Authorization",
            format!(
                "Basic {}",
                STANDARD.encode(format!("{}:{}", get("username"), get("password")))
            ),
        ),
        Some("bearer") => headers.set("Authorization", format!("Bearer {}", get("token"))),
        Some("apikey") if get("in") == "query" => {
            url.push(if url.contains('?') { '&' } else { '?' });
            url.push_str(&format!(
                "{}={}",
                encode_component(&get("key")),
                encode_component(&get("value"))
            ));
        }
        Some("apikey") => headers.set(&get("key"), get("value")),
        _ => {}
    }
    let body_spec = &request["body"];
    let mut body = body_spec["raw"].as_str().unwrap_or("").to_string();
    match body_spec["mode"].as_str() {
        Some("urlencoded") => {
            let mut form = url::form_urlencoded::Serializer::new(String::new());
            for row in body_spec["urlencoded"].as_array().into_iter().flatten() {
                form.append_pair(&js_string(&row["key"]), &js_string(&row["value"]));
            }
            body = form.finish();
            headers.set_default("Content-Type", "application/x-www-form-urlencoded");
        }
        Some("graphql") => {
            let variables = body_spec["graphql"]["variables"]
                .as_str()
                .filter(|v| !v.is_empty())
                .unwrap_or("{}");
            let variables: Value = serde_json::from_str(variables)
                .map_err(|_| invalid("GraphQL variables must be valid JSON"))?;
            body =
                json!({"query": body_spec["graphql"]["query"], "variables": variables}).to_string();
            headers.set_default("Content-Type", "application/json");
        }
        _ => {}
    }
    let pairs = &headers.0;
    let language = payload["language"]
        .as_str()
        .unwrap_or("cURL")
        .to_lowercase();
    let code = match language.as_str() {
        "curl" => {
            let mut code = format!("curl --request {} {}", shell(&method), shell(&url));
            for (key, value) in pairs {
                code.push_str(&format!(" \\\n  --header {}", shell(&format!("{key}: {value}"))));
            }
            if body_spec["mode"] == "formdata" {
                for row in body_spec["formdata"].as_array().into_iter().flatten().filter(|row| row["disabled"] != true) {
                    if crate::files::is_file(row) {
                        // As Postman writes them: the file is read by curl from its path.
                        for src in crate::files::sources(&row["src"]) {
                            code.push_str(&format!(" \\\n  --form {}", shell(&format!("{}=@\"{}\"", js_string(&row["key"]), src.replace('"', "\\\"")))));
                        }
                    } else {
                        code.push_str(&format!(" \\\n  --form-string {}", shell(&format!("{}={}", js_string(&row["key"]), js_string(&row["value"])))));
                    }
                }
            } else if body_spec["mode"] == "file" {
                if let Some(src) = body_spec["file"]["src"].as_str().filter(|src| !src.is_empty()) {
                    code.push_str(&format!(" \\\n  --data-binary {}", shell(&format!("@{src}"))));
                }
            } else if !body.is_empty() {
                code.push_str(&format!(" \\\n  --data-raw {}", shell(&body)));
            }
            code
        }
        "javascript" | "nodejs" => {
            let mut options = Map::new();
            options.insert("method".into(), json!(method));
            options.insert("headers".into(), Value::Object(pairs.iter().map(|(k, v)| (k.clone(), json!(v))).collect()));
            if !body.is_empty() && method != "GET" && method != "HEAD" {
                options.insert("body".into(), json!(body));
            }
            options.insert("redirect".into(), json!(if payload["followRedirects"] == false { "manual" } else { "follow" }));
            format!(
                "const response = await fetch({}, {});\nconsole.log(response.status, await response.text());",
                quote(&url),
                serde_json::to_string_pretty(&options).unwrap_or_default()
            )
        }
        "python" => {
            let parsed = url::Url::parse(&url).map_err(|_| invalid("Invalid URL"))?;
            let host = match parsed.port() {
                Some(port) => format!("{}:{port}", parsed.host_str().unwrap_or("")),
                None => parsed.host_str().unwrap_or("").to_string(),
            };
            let target = format!("{}{}", parsed.path(), parsed.query().map(|q| format!("?{q}")).unwrap_or_default());
            format!(
                "import http.client\n\nconnection = http.client.{}({})\nconnection.request({}, {}, body={}, headers={{{}}})\nresponse = connection.getresponse()\nprint(response.status, response.read().decode())\nconnection.close()",
                if parsed.scheme() == "https" { "HTTPSConnection" } else { "HTTPConnection" },
                quote(&host),
                quote(&method),
                quote(&target),
                quote(&body),
                pairs.iter().map(|(k, v)| format!("{}: {}", quote(k), quote(v))).collect::<Vec<_>>().join(", ")
            )
        }
        "go" => format!(
            "package main\n\nimport (\"fmt\"; \"io\"; \"net/http\"; \"strings\")\n\nfunc main() {{\n  req, err := http.NewRequest({}, {}, strings.NewReader({}))\n  if err != nil {{ panic(err) }}\n{}\n  res, err := http.DefaultClient.Do(req)\n  if err != nil {{ panic(err) }}\n  defer res.Body.Close()\n  data, err := io.ReadAll(res.Body)\n  if err != nil {{ panic(err) }}\n  fmt.Println(res.Status, string(data))\n}}",
            quote(&method),
            quote(&url),
            quote(&body),
            pairs.iter().map(|(k, v)| format!("  req.Header.Set({}, {})", quote(k), quote(v))).collect::<Vec<_>>().join("\n")
        ),
        "rust" => format!(
            "#[tokio::main]\nasync fn main() -> Result<(), Box<dyn std::error::Error>> {{\n  let client = reqwest::Client::new();\n  let response = client.request(reqwest::Method::from_bytes({}.as_bytes())?, {}){}{}\n    .send().await?;\n  println!(\"{{}} {{}}\", response.status(), response.text().await?);\n  Ok(())\n}}",
            rust(&method),
            rust(&url),
            pairs.iter().map(|(k, v)| format!("\n    .header({}, {})", rust(k), rust(v))).collect::<String>(),
            if body.is_empty() { String::new() } else { format!("\n    .body({})", rust(&body)) }
        ),
        "java" => format!(
            "var client = java.net.http.HttpClient.newBuilder().followRedirects(java.net.http.HttpClient.Redirect.{}).build();\nvar request = java.net.http.HttpRequest.newBuilder(java.net.URI.create({}))\n    .method({}, java.net.http.HttpRequest.BodyPublishers.ofString({})){}\n    .build();\nvar response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());\nSystem.out.println(response.body());",
            if payload["followRedirects"] == false { "NEVER" } else { "NORMAL" },
            quote(&url),
            quote(&method),
            quote(&body),
            pairs.iter().map(|(k, v)| format!("\n    .header({}, {})", quote(k), quote(v))).collect::<String>()
        ),
        "csharp" | "c#" => format!(
            "using var client = new HttpClient();\nusing var request = new HttpRequestMessage(new HttpMethod({}), {});\n{}{}\nusing var response = await client.SendAsync(request);\nConsole.WriteLine(await response.Content.ReadAsStringAsync());",
            quote(&method),
            quote(&url),
            if body.is_empty() { String::new() } else { format!("request.Content = new StringContent({});\n", quote(&body)) },
            pairs
                .iter()
                .map(|(k, v)| if k.eq_ignore_ascii_case("content-type") && !body.is_empty() {
                    format!("request.Content.Headers.ContentType = System.Net.Http.Headers.MediaTypeHeaderValue.Parse({});", quote(v))
                } else {
                    format!("request.Headers.TryAddWithoutValidation({}, {});", quote(k), quote(v))
                })
                .collect::<Vec<_>>()
                .join("\n")
        ),
        "powershell" => format!(
            "Invoke-RestMethod -Method '{}' -Uri '{}' -Headers @{{{}}}{}",
            powershell(&method),
            powershell(&url),
            pairs.iter().map(|(k, v)| format!("'{}'='{}'", powershell(k), powershell(v))).collect::<Vec<_>>().join("; "),
            if body.is_empty() { String::new() } else { format!(" -Body '{}'", powershell(&body)) }
        ),
        _ => return Err(invalid("Unsupported code generation language")),
    };
    Ok(json!({"code": code}))
}
