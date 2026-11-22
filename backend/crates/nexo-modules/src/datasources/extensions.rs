//! The extensions of the engines that are not relational as the application sees them: the
//! `keyvalue` methods (DB-35) and `rest.request` (DB-36), each one relayed to the session's
//! driver with its own message, read here so a wrong field is refused.
use crate::Modules;
use nexo_domain::{Error, Result};
use nexo_driver_sdk::{keyvalue, rest};
use serde_json::Value;

impl Modules {
    pub(super) async fn extension_relay(
        &self,
        session: &str,
        method: &str,
        request: Value,
    ) -> Result<Value> {
        use keyvalue::methods as kv;
        match method {
            kv::SCAN => {
                self.relay::<keyvalue::ScanParams, keyvalue::ScanResult>(
                    session, method, request, "scan",
                )
                .await
            }
            kv::GET => {
                self.relay::<keyvalue::GetParams, keyvalue::KeyValue>(
                    session, method, request, "key",
                )
                .await
            }
            kv::WRITE => {
                self.relay::<keyvalue::WriteParams, keyvalue::Written>(
                    session, method, request, "change",
                )
                .await
            }
            kv::COMMAND => {
                self.relay::<keyvalue::CommandParams, keyvalue::Reply>(
                    session, method, request, "command",
                )
                .await
            }
            kv::SUBSCRIBE => {
                self.relay::<keyvalue::SubscribeParams, keyvalue::Subscribed>(
                    session,
                    method,
                    request,
                    "subscription",
                )
                .await
            }
            kv::EVENTS => {
                self.relay::<keyvalue::EventsParams, keyvalue::Events>(
                    session, method, request, "request",
                )
                .await
            }
            kv::UNSUBSCRIBE => {
                self.relay::<keyvalue::UnsubscribeParams, Value>(
                    session, method, request, "request",
                )
                .await
            }
            rest::methods::REQUEST => {
                self.relay::<rest::RestRequest, rest::RestResponse>(
                    session, method, request, "request",
                )
                .await
            }
            other => Err(Error::Validation(format!("Unknown method {other}"))),
        }
    }
}
