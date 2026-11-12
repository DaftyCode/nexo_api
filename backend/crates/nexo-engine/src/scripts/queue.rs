//! What scripts queue for the host: requests of `pm.sendRequest` and `nx.mongo` calls, and
//! their answers delivered back to the promises that wait for them.
use super::*;

impl ScriptSession {
    /// Requests queued by `pm.sendRequest` since the last call.
    pub fn take_queue(&self) -> Result<Vec<(String, Value)>> {
        let queue = self.json("__nexo.queue()")?;
        Ok(queue
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|entry| {
                        (
                            entry["id"].as_str().unwrap_or_default().to_string(),
                            entry["request"].clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    /// Calls queued by `nx.mongo` since the last call: their id and the call.
    pub fn take_mongo(&self) -> Result<Vec<(String, Value)>> {
        let queue = self.json("__nexo.mongoQueue()")?;
        Ok(queue
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|entry| {
                        let id = entry["id"].as_str().unwrap_or_default().to_string();
                        (id, entry["call"].clone())
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    /// Answers an `nx.mongo` call: its result in Extended JSON, or why it failed.
    pub fn deliver_mongo(
        &self,
        id: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Result<()> {
        self.evaluate(&format!(
            "__nexo.deliverMongo({},{},{})",
            serde_json::to_string(id).map_err(infrastructure)?,
            serde_json::to_string(&result).map_err(infrastructure)?,
            serde_json::to_string(&error).map_err(infrastructure)?
        ))?;
        Ok(())
    }
    pub fn deliver(&self, id: &str, result: Option<&Value>, error: Option<&str>) -> Result<()> {
        self.evaluate(&format!(
            "__nexo.deliver({},{},{})",
            serde_json::to_string(id).map_err(infrastructure)?,
            serde_json::to_string(&result.map(script_response)).map_err(infrastructure)?,
            serde_json::to_string(&error).map_err(infrastructure)?
        ))?;
        Ok(())
    }
    /// What the shell command gave, as JSON: the current database, the kind of result and
    /// its value in Extended JSON, or the error.
    pub(crate) fn output(&self) -> Result<String> {
        self.evaluate("__shell.output()")?
            .ok_or_else(|| Error::Infrastructure("The shell gave no output".into()))
    }
}
