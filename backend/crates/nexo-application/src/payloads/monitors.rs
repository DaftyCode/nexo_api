//! Payloads of the monitors: what they are doing and running one now.
use super::*;

payload! {
    /// `monitor.status`: the monitors of a workspace (running, next run) and the runs that
    /// finished after the sequence `after`, in every workspace, to notify their failures.
    closed MonitorStatusPayload {
        required { workspace "workspace": String => "string" }
        optional { after "after": u64 => "number" }
    }
}

payload! {
    /// `monitor.run`: runs a monitor now, unless it is still running.
    closed MonitorRunPayload {
        required {
            workspace "workspace": String => "string",
            id "id": String => "string",
        }
        optional {}
    }
}
