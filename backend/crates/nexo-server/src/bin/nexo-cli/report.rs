//! The JUnit report of a run.
use super::*;

pub(super) fn rows(value: Value) -> Value {
    value.get("values").cloned().unwrap_or(value)
}
/// Characters XML 1.0 does not allow, removed from JUnit output.
pub(super) fn xml(text: &str) -> String {
    text.chars()
        .filter(|c| matches!(c, '\t' | '\n' | '\r') || !c.is_control())
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
pub(super) fn junit(result: &Value, seconds: f64) -> String {
    let tests = result["assertions"].as_array().cloned().unwrap_or_default();
    let failures = tests.iter().filter(|x| x["passed"] == false).count();
    let skipped = tests.iter().filter(|x| x["skipped"] == true).count();
    let cases = tests
        .iter()
        .map(|test| {
            let name = xml(test["name"].as_str().unwrap_or("Assertion"));
            let class = format!("iteration-{}", test["iteration"].as_u64().unwrap_or(0) + 1);
            if test["skipped"] == true {
                format!("<testcase classname=\"{class}\" name=\"{name}\"><skipped/></testcase>")
            } else if test["passed"] == true {
                format!("<testcase classname=\"{class}\" name=\"{name}\"/>")
            } else {
                format!(
                    "<testcase classname=\"{class}\" name=\"{name}\"><failure message=\"{}\"/></testcase>",
                    xml(test["error"].as_str().unwrap_or("Assertion failed"))
                )
            }
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><testsuites tests=\"{}\" failures=\"{failures}\" time=\"{seconds:.3}\"><testsuite name=\"Nexo\" tests=\"{}\" failures=\"{failures}\" skipped=\"{skipped}\" time=\"{seconds:.3}\">{cases}</testsuite></testsuites>",
        tests.len(),
        tests.len()
    )
}
