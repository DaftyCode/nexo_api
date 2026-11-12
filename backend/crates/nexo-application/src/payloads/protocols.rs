//! Payloads of realtime connections, gRPC, mock servers, MCP servers and datasets.
use super::*;

payload! {
    /// `realtime.connect`: a WebSocket, Socket.IO, MQTT, Kafka or GraphQL subscription
    /// connection.
    closed RealtimeConnectPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            protocol "protocol": String => "string",
            url "url": String => "string",
            headers "headers": Value => "Record<string, string> | readonly object[]",
            subprotocols "subprotocols": Vec<String> => "readonly string[]",
            path "path": String => "string",
            transports "transports": String => "string",
            auth "auth": Map<String, Value> => "Record<string, unknown>",
            client_id "clientId": String => "string",
            clean "clean": bool => "boolean",
            username "username": String => "string",
            password "password": String => "string",
            topic "topic": String => "string",
            qos "qos": u8 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            ca_pem "caPem": String => "string",
            cert_pem "certPem": String => "string",
            key_pem "keyPem": String => "string",
            tls "tls": bool => "boolean",
            sasl_mechanism "saslMechanism": String => "string",
            query "query": String => "string",
            variables "variables": Value => "unknown",
            operation_name "operationName": String => "string",
            graphql_protocol "graphqlProtocol": String => "string",
            connection_params "connectionParams": Value => "unknown",
        }
    }
}

payload! {
    /// `realtime.send`: a message, an MQTT subscribe/unsubscribe with `action`, or for Kafka
    /// `produce` (key, headers, partition), `subscribe` (from earliest, latest or an offset),
    /// `unsubscribe` and `topics`.
    closed RealtimeSendPayload {
        required { id "id": String => "string" }
        optional {
            workspace "workspace": String => "string",
            action "action": String => "string",
            message "message": Value => "unknown",
            topic "topic": String => "string",
            event "event": String => "string",
            qos "qos": u8 => "number",
            retain "retain": bool => "boolean",
            key "key": String => "string",
            partition "partition": i32 => "number",
            headers "headers": Value => "Record<string, string> | readonly object[]",
            from "from": String => "'earliest' | 'latest' | 'offset'",
            offset "offset": i64 => "number",
        }
    }
}

payload! {
    /// `realtime.poll`: the events after the sequence number `after`.
    closed RealtimePollPayload {
        required { id "id": String => "string" }
        optional {
            workspace "workspace": String => "string",
            after "after": u64 => "number",
        }
    }
}

payload! {
    /// `grpc`: a call with a supplied proto.
    closed GrpcPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            url "url": String => "string",
            proto "proto": String => "string",
            reflection "reflection": bool => "boolean",
            service "service": String => "string",
            method "method": String => "string",
            tls "tls": bool => "boolean",
            ca_pem "caPem": String => "string",
            cert_pem "certPem": String => "string",
            key_pem "keyPem": String => "string",
            message "message": Value => "unknown",
            messages "messages": Vec<Value> => "readonly unknown[]",
            metadata "metadata": Value => "unknown",
            timeout "timeout": u64 => "number",
        }
    }
}

payload! {
    /// `mock.start`: a mock server for the examples, on `port` (0 or none for any free one).
    closed MockStartPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            id "id": String => "string",
            port "port": u64 => "number",
            examples "examples": Vec<Map<String, Value>> => "readonly object[]",
        }
    }
}

payload! {
    /// `mcp.request`: a JSON-RPC call to an MCP server.
    closed McpRequestPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            url "url": String => "string",
            method "method": String => "string",
            params "params": Value => "unknown",
            headers "headers": Value => "Record<string, string> | readonly object[]",
            session_id "sessionId": String => "string",
        }
    }
}

payload! {
    /// `dataset.import` and `dataset.parse`: JSON or CSV `content`, or `rows`.
    closed DatasetRowsPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            id "id": String => "string",
            content "content": String => "string",
            rows "rows": Vec<Value> => "readonly unknown[]",
        }
    }
}

payload! {
    /// `dataset.query`: read-only SQL over a dataset.
    closed DatasetQueryPayload {
        required {
            id "id": String => "string",
            sql "sql": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}
