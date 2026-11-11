//! Payloads of the execution operations, as types. They are checked when a request arrives,
//! before vault secrets are resolved or the engine runs anything: a misspelled field or a
//! wrong type is answered with a 400 that names it. The TypeScript interfaces in
//! `src/app/application/payloads.ts` come from the same declarations, and a test fails when
//! they are out of date.
//!
//! The top-level fields are closed: unknown ones are refused. Documents inside them
//! (collections, items, authorizations) keep the Postman format and stay open.
use crate::operations::{GitOperation, Operation};
use nexo_domain::{Error, Result};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

/// Declares a payload struct and its TypeScript interface. `closed` refuses unknown fields;
/// `open` keeps them in `extra`, for rows that follow an outside format.
macro_rules! payload {
    (@struct [$($derive:tt)*] $(#[$meta:meta])* $name:ident
        { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal,)* }
        { $($ofield:ident $owire:literal : $oty:ty => $ots:literal,)* }
        { $($extra:tt)* }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Default, Deserialize, Serialize)]
        $($derive)*
        pub struct $name {
            $(
                #[serde(rename = $rwire)]
                pub $rfield: $rty,
            )*
            $(
                #[serde(rename = $owire, default, skip_serializing_if = "Option::is_none")]
                pub $ofield: Option<$oty>,
            )*
            $($extra)*
        }
    };
    (
        $(#[$meta:meta])*
        closed $name:ident {
            required { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal),* $(,)? }
            optional { $($ofield:ident $owire:literal : $oty:ty => $ots:literal),* $(,)? }
        }
    ) => {
        payload!(@struct [#[serde(deny_unknown_fields)]] $(#[$meta])* $name
            { $($rfield $rwire : $rty => $rts,)* }
            { $($ofield $owire : $oty => $ots,)* }
            {}
        );
        impl $name {
            pub const TYPESCRIPT: &'static str = concat!(
                "export interface ", stringify!($name), " {\n",
                $("  ", $rwire, ": ", $rts, ";\n",)*
                $("  ", $owire, "?: ", $ots, ";\n",)*
                "}\n"
            );
        }
    };
    (
        $(#[$meta:meta])*
        open $name:ident {
            required { $($rfield:ident $rwire:literal : $rty:ty => $rts:literal),* $(,)? }
            optional { $($ofield:ident $owire:literal : $oty:ty => $ots:literal),* $(,)? }
        }
    ) => {
        payload!(@struct [] $(#[$meta])* $name
            { $($rfield $rwire : $rty => $rts,)* }
            { $($ofield $owire : $oty => $ots,)* }
            {
                /// Fields of the outside format that Nexo passes along.
                #[serde(flatten)]
                pub extra: Map<String, Value>,
            }
        );
        impl $name {
            pub const TYPESCRIPT: &'static str = concat!(
                "export interface ", stringify!($name), " {\n",
                $("  ", $rwire, ": ", $rts, ";\n",)*
                $("  ", $owire, "?: ", $ots, ";\n",)*
                "  [field: string]: unknown;\n",
                "}\n"
            );
        }
    };
}

payload! {
    /// A variable as Postman environments and collections store it.
    open VariableRow {
        required { key "key": String => "string" }
        optional {
            value "value": Value => "unknown",
            enabled "enabled": bool => "boolean",
            disabled "disabled": bool => "boolean",
            kind "type": String => "string",
        }
    }
}

payload! {
    /// The collection and folders a single request belongs to, root first.
    closed ExecutionContext {
        required {}
        optional { ancestors "ancestors": Vec<Map<String, Value>> => "readonly object[]" }
    }
}

payload! {
    /// A file chosen for a request: the name its form-data field or binary body references
    /// (`src`) and its contents in base64. It is sent apart from the request, so scripts and
    /// saved documents only see the name.
    closed FileAttachment {
        required {
            src "src": String => "string",
            content "content": String => "string",
        }
        optional { content_type "contentType": String => "string" }
    }
}

payload! {
    /// A cookie of a jar: its domain, path and name identify it.
    closed CookieKey {
        required {
            domain "domain": String => "string",
            path "path": String => "string",
            name "name": String => "string",
        }
        optional {}
    }
}

payload! {
    /// `cookies.set`: adds a cookie to the workspace jar, or replaces the `original` one when
    /// it is edited. Without `expires` (milliseconds since 1970) it is a session cookie, kept
    /// until it is deleted.
    closed CookieSetPayload {
        required {
            name "name": String => "string",
            value "value": String => "string",
            domain "domain": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            path "path": String => "string",
            expires "expires": u64 => "number",
            include_subdomains "includeSubdomains": bool => "boolean",
            secure "secure": bool => "boolean",
            http_only "httpOnly": bool => "boolean",
            same_site "sameSite": String => "'Strict' | 'Lax' | 'None'",
            original "original": CookieKey => "CookieKey",
        }
    }
}

payload! {
    /// `cookies.delete`: one cookie of the workspace jar.
    closed CookieDeletePayload {
        required {
            domain "domain": String => "string",
            path "path": String => "string",
            name "name": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// What a run status has already delivered; it answers only what is new.
    closed RunCursor {
        required {}
        optional {
            results "results": u64 => "number",
            assertions "assertions": u64 => "number",
            logs "logs": u64 => "number",
        }
    }
}

payload! {
    /// `request`: sends one request (or the collection item given), with its scripts.
    closed RequestPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            id "id": String => "string",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            timeout "timeout": u64 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
            trust_redirect_credentials "trustRedirectCredentials": bool => "boolean",
            transport "transport": Value => "unknown",
            files "files": Vec<FileAttachment> => "readonly FileAttachment[]",
        }
    }
}

payload! {
    /// `run`: starts a collection run, or with `action: "status"` reports one from `after`.
    closed RunPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": RunAction => "'status'",
            id "id": String => "string",
            after "after": RunCursor => "RunCursor",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            data "data": Vec<Value> => "readonly unknown[]",
            iterations "iterations": u64 => "number",
            delay "delay": u64 => "number",
            global_timeout "globalTimeout": u64 => "number",
            timeout "timeout": u64 => "number",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
            trust_redirect_credentials "trustRedirectCredentials": bool => "boolean",
            transport "transport": Value => "unknown",
            files "files": Vec<FileAttachment> => "readonly FileAttachment[]",
        }
    }
}

payload! {
    /// `cancel`, `run.pause`, `run.resume`, `realtime.close`, `mock.stop`,
    /// `performance.cancel`: an identifier.
    closed IdPayload {
        required { id "id": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `realtime.list`, `mock.list`, `cookies.list`, `cookies.clear`: only the workspace.
    closed WorkspacePayload {
        required {}
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `oauth2.token`: "Get New Access Token" for an authorization, or a refresh with `tokenId`.
    closed Oauth2TokenPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            token_id "tokenId": String => "string",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
        }
    }
}

payload! {
    /// `oauth2.authorize`: a browser sign-in. `start` takes the authorization like
    /// `oauth2.token`; the other actions take its `session`, and `complete` the `url` the
    /// browser returned to.
    closed Oauth2AuthorizePayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": SignInAction => "'start' | 'status' | 'open' | 'complete' | 'cancel'",
            session "session": String => "string",
            url "url": String => "string",
            open_browser "openBrowser": bool => "boolean",
            request "request": Map<String, Value> => "object",
            item "item": Map<String, Value> => "object",
            collection "collection": Map<String, Value> => "object",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
        }
    }
}

payload! {
    /// `oauth2.tokens`: "Manage Tokens" (`list`, `details` or `delete` of the token `id`), or
    /// `add` a token the person pasted, under `name`.
    closed Oauth2TokensPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": TokensAction => "'list' | 'details' | 'delete' | 'add'",
            id "id": String => "string",
            name "name": String => "string",
            access_token "accessToken": String => "string",
            refresh_token "refreshToken": String => "string",
            id_token "idToken": String => "string",
            expires_in "expiresIn": u64 => "number",
        }
    }
}

payload! {
    /// `oauth.token`: posts form `fields` to a token endpoint.
    closed OauthTokenPayload {
        required { url "url": String => "string" }
        optional {
            workspace "workspace": String => "string",
            fields "fields": Map<String, Value> => "Record<string, unknown>",
            headers "headers": Value => "Record<string, string> | readonly object[]",
        }
    }
}

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

payload! {
    /// `import`: a collection, environment, cURL command, HAR or OpenAPI document.
    closed ImportPayload {
        required { content "content": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `api.inspect`: the linter's findings and the outline of an OpenAPI or Swagger
    /// definition.
    closed ApiInspectPayload {
        required { source "source": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `api.diff`: what changed from the `base` definition to `source`, with the breaking
    /// changes marked.
    closed ApiDiffPayload {
        required {
            base "base": String => "string",
            source "source": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `codegen`: code that sends `request` in `language`.
    closed CodegenPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            request "request": Map<String, Value> => "object",
            language "language": String => "string",
            variant "variant": String => "string",
            follow_redirects "followRedirects": bool => "boolean",
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
    /// `performance`: starts a load test of `request`, or with `action: "status"` reports one.
    closed PerformancePayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            action "action": RunAction => "'status'",
            id "id": String => "string",
            request "request": Map<String, Value> => "object",
            users "users": u64 => "number",
            duration "duration": u64 => "number",
            profile "profile": String => "string",
            variables "variables": Vec<VariableRow> => "readonly VariableRow[]",
            globals "globals": Vec<VariableRow> => "readonly VariableRow[]",
            context "context": ExecutionContext => "ExecutionContext",
            strict_ssl "strictSSL": bool => "boolean",
            follow_redirects "followRedirects": bool => "boolean",
        }
    }
}

payload! {
    /// A MongoDB connection: the URI without a password (`mongodb://` or `mongodb+srv://`),
    /// the password (usually a `{{vault:…}}` reference) and the PEM of a CA to trust besides
    /// the system's and of a client certificate and key.
    closed MongoConnection {
        required { uri "uri": String => "string" }
        optional {
            password "password": String => "string",
            ca_pem "caPem": String => "string",
            cert_pem "certPem": String => "string",
            key_pem "keyPem": String => "string",
        }
    }
}

payload! {
    /// `mongo.test`: connects, pings and describes the deployment. `mongo.databases`: the
    /// databases the user may read.
    closed MongoConnectionPayload {
        required { connection "connection": MongoConnection => "MongoConnection" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collections`: the collections, views and time series of a database.
    closed MongoDatabasePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.stats`: the size and indexes of a collection.
    closed MongoCollectionPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.find`: the first page of a query. Filter, projection, sort and collation are
    /// Extended JSON objects; `hint` is an index name or its keys. `id`, chosen by the client,
    /// cancels it with `mongo.cancel`.
    closed MongoFindPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            projection "projection": Map<String, Value> => "object",
            sort "sort": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
            page_size "pageSize": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.more`: the next page of the `cursor` a `mongo.find` returned.
    closed MongoMorePayload {
        required {
            cursor "cursor": String => "string",
            id "id": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            page_size "pageSize": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.count`: how many documents match a filter (`countDocuments`).
    closed MongoCountPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            filter "filter": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.insert`: inserts documents (Extended JSON). Writes name the saved connection
    /// (`connectionId`): a read-only one is refused.
    closed MongoInsertPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            documents "documents": Vec<Map<String, Value>> => "readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.update`: `update` is an update document or a pipeline. With `many`, `expected`
    /// is the count the person confirmed; a filter that matches another number writes nothing.
    closed MongoUpdatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
            update "update": Value => "object | readonly object[]",
        }
        optional {
            workspace "workspace": String => "string",
            many "many": bool => "boolean",
            expected "expected": u64 => "number",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.replace`: replaces the document the filter matches.
    closed MongoReplacePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
            replacement "replacement": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.delete`: with `many`, `expected` as in `mongo.update`; an empty filter (every
    /// document) also needs `confirm` with the collection's name.
    closed MongoDeletePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            filter "filter": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            many "many": bool => "boolean",
            expected "expected": u64 => "number",
            confirm "confirm": String => "string",
            write_concern "writeConcern": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.undo`: undoes a recorded change (a `mongo-change` document).
    closed MongoUndoPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            change "change": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collection.create`: also creates its database. Options: `capped`, `size`,
    /// `max`, `timeseries`, `validator`, `validationLevel`, `validationAction`, `collation`,
    /// `expireAfterSeconds`.
    closed MongoCollectionCreatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            options "options": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.collection.rename`: within its database.
    closed MongoCollectionRenamePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            to "to": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.collection.drop`: `confirm` repeats the collection's name.
    closed MongoCollectionDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.database.drop`: `confirm` repeats the database's name.
    closed MongoDatabaseDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.index.create`: `keys` in Extended JSON (`{a: 1, b: -1}`, `{title: "text"}`,
    /// `{loc: "2dsphere"}`, `{"$**": 1}`). Options: `name`, `unique`, `sparse`, `hidden`,
    /// `expireAfterSeconds`, `partialFilterExpression`, `collation`, `weights`,
    /// `default_language`, `language_override`, `textIndexVersion`, `2dsphereIndexVersion`,
    /// `bits`, `min`, `max`, `wildcardProjection`.
    closed MongoIndexCreatePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            keys "keys": Map<String, Value> => "object",
        }
        optional {
            workspace "workspace": String => "string",
            options "options": Map<String, Value> => "object",
        }
    }
}

payload! {
    /// `mongo.index.hide`: hides an index from the query planner (`hidden`), or shows it.
    closed MongoIndexHidePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            name "name": String => "string",
            hidden "hidden": bool => "boolean",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.index.drop`: `confirm` repeats the index's name.
    closed MongoIndexDropPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
            name "name": String => "string",
            confirm "confirm": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.explain`: how the server runs a `find` (filter, projection, sort, collation,
    /// hint, skip and limit as in `mongo.find`) or, with `pipeline`, an aggregation.
    /// `executionStats` runs the query to measure it; `queryPlanner` (the default) only plans
    /// it. `id` cancels it with `mongo.cancel`.
    closed MongoExplainPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            id "id": String => "string",
            database "database": String => "string",
            collection "collection": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            verbosity "verbosity": ExplainVerbosity => "'queryPlanner' | 'executionStats'",
            filter "filter": Map<String, Value> => "object",
            projection "projection": Map<String, Value> => "object",
            sort "sort": Map<String, Value> => "object",
            collation "collation": Map<String, Value> => "object",
            hint "hint": Value => "string | object",
            skip "skip": u64 => "number",
            limit "limit": u64 => "number",
            pipeline "pipeline": Vec<Map<String, Value>> => "readonly object[]",
        }
    }
}

payload! {
    /// `mongo.profile`: the profiler level of a database and its `slowms`.
    closed MongoProfilePayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// `mongo.profile.set`: changes the profiler of a database on the server: `level` 0 (off),
    /// 1 (operations slower than `slowms`) or 2 (every operation).
    closed MongoProfileSetPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            connection_id "connectionId": String => "string",
            database "database": String => "string",
            level "level": u8 => "0 | 1 | 2",
        }
        optional {
            workspace "workspace": String => "string",
            slowms "slowms": u64 => "number",
        }
    }
}

payload! {
    /// `mongo.profile.entries`: the slowest operations in `system.profile`, of the whole
    /// database or of one `collection`.
    closed MongoProfileEntriesPayload {
        required {
            connection "connection": MongoConnection => "MongoConnection",
            database "database": String => "string",
        }
        optional {
            workspace "workspace": String => "string",
            collection "collection": String => "string",
            limit "limit": u64 => "number",
        }
    }
}

/// How much an explain tells: the plan only, or the plan run and measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExplainVerbosity {
    #[default]
    QueryPlanner,
    ExecutionStats,
}

payload! {
    /// `mongo.close`: closes a cursor the interface no longer reads.
    closed MongoClosePayload {
        required { cursor "cursor": String => "string" }
        optional { workspace "workspace": String => "string" }
    }
}

payload! {
    /// A collection written to the workspace project by Git `export`.
    closed GitFile {
        required {
            id "id": String => "string",
            value "value": Value => "unknown",
        }
        optional {}
    }
}

payload! {
    /// Git operations on the workspace project.
    closed GitPayload {
        required {}
        optional {
            workspace "workspace": String => "string",
            branch "branch": String => "string",
            message "message": String => "string",
            files "files": Vec<GitFile> => "readonly GitFile[]",
            remote "remote": String => "string",
            url "url": String => "string",
            rebase "rebase": bool => "boolean",
            force_with_lease "forceWithLease": bool => "boolean",
        }
    }
}

/// What an `oauth2.authorize` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SignInAction {
    Start,
    Status,
    Open,
    Complete,
    Cancel,
}

/// What an `oauth2.tokens` call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TokensAction {
    List,
    Details,
    Delete,
    Add,
}

/// What a `run` call asks for besides starting a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunAction {
    Status,
}

fn check<T: DeserializeOwned + Serialize>(
    operation: impl std::fmt::Display,
    payload: Value,
) -> Result<Value> {
    // serde would also read a struct from an array of its fields.
    if !payload.is_object() {
        return Err(Error::Validation(format!(
            "Invalid {operation} payload: expected an object"
        )));
    }
    let typed: T = serde_path_to_error::deserialize(payload).map_err(|error| {
        let path = error.path().to_string();
        let reason = error.into_inner();
        Error::Validation(if path == "." {
            format!("Invalid {operation} payload: {reason}")
        } else {
            format!("Invalid {operation} payload at {path}: {reason}")
        })
    })?;
    serde_json::to_value(typed).map_err(|error| Error::Infrastructure(error.to_string()))
}

/// Declares which payload each operation takes: `validate` matches every operation without a
/// wildcard, so a new operation without a payload does not compile, and the TypeScript map
/// of payloads comes from the same list.
macro_rules! operation_payloads {
    ($($operation:ident => $payload:ident),+ $(,)?) => {
        /// Checks an operation's payload against its type and returns it as the engine reads
        /// it.
        pub fn validate(operation: Operation, payload: Value) -> Result<Value> {
            match operation {
                $(Operation::$operation => check::<$payload>(operation, payload),)+
            }
        }
        /// `OperationPayloads`: the payload type of each operation, for TypeScript.
        fn typescript_map() -> String {
            let mut map = String::from(
                "/** The payload of each execution operation, checked by the backend. */\n\
                 export interface OperationPayloads {\n",
            );
            $({
                // Quoted only when the name is not an identifier, as Prettier writes it.
                let name = Operation::$operation.as_str();
                let key = if name.contains('.') {
                    format!("'{name}'")
                } else {
                    name.to_string()
                };
                map.push_str(&format!("  {key}: {};\n", stringify!($payload)));
            })+
            map.push_str("}\n");
            map
        }
        /// Each payload's interface, once, in the order of first use.
        fn typescript_interfaces() -> Vec<&'static str> {
            let mut interfaces: Vec<&'static str> = Vec::new();
            $(if !interfaces.contains(&$payload::TYPESCRIPT) {
                interfaces.push($payload::TYPESCRIPT);
            })+
            interfaces
        }
    };
}

operation_payloads! {
    Request => RequestPayload,
    Run => RunPayload,
    Cancel => IdPayload,
    RunPause => IdPayload,
    RunResume => IdPayload,
    Import => ImportPayload,
    ApiInspect => ApiInspectPayload,
    ApiDiff => ApiDiffPayload,
    Codegen => CodegenPayload,
    RealtimeConnect => RealtimeConnectPayload,
    RealtimeSend => RealtimeSendPayload,
    RealtimeClose => IdPayload,
    RealtimePoll => RealtimePollPayload,
    RealtimeList => WorkspacePayload,
    Grpc => GrpcPayload,
    MockStart => MockStartPayload,
    MockStop => IdPayload,
    MockList => WorkspacePayload,
    DatasetQuery => DatasetQueryPayload,
    DatasetImport => DatasetRowsPayload,
    DatasetSchema => IdPayload,
    DatasetParse => DatasetRowsPayload,
    DatasetDelete => IdPayload,
    McpRequest => McpRequestPayload,
    OauthToken => OauthTokenPayload,
    Oauth2Token => Oauth2TokenPayload,
    Oauth2Authorize => Oauth2AuthorizePayload,
    Oauth2Tokens => Oauth2TokensPayload,
    CookiesList => WorkspacePayload,
    CookiesClear => WorkspacePayload,
    CookiesSet => CookieSetPayload,
    CookiesDelete => CookieDeletePayload,
    Performance => PerformancePayload,
    PerformanceCancel => IdPayload,
    MongoTest => MongoConnectionPayload,
    MongoDatabases => MongoConnectionPayload,
    MongoCollections => MongoDatabasePayload,
    MongoStats => MongoCollectionPayload,
    MongoFind => MongoFindPayload,
    MongoMore => MongoMorePayload,
    MongoCount => MongoCountPayload,
    MongoCancel => IdPayload,
    MongoClose => MongoClosePayload,
    MongoInsert => MongoInsertPayload,
    MongoUpdate => MongoUpdatePayload,
    MongoReplace => MongoReplacePayload,
    MongoDelete => MongoDeletePayload,
    MongoUndo => MongoUndoPayload,
    MongoCollectionCreate => MongoCollectionCreatePayload,
    MongoCollectionRename => MongoCollectionRenamePayload,
    MongoCollectionDrop => MongoCollectionDropPayload,
    MongoDatabaseDrop => MongoDatabaseDropPayload,
    MongoIndexes => MongoCollectionPayload,
    MongoIndexCreate => MongoIndexCreatePayload,
    MongoIndexHide => MongoIndexHidePayload,
    MongoIndexDrop => MongoIndexDropPayload,
    MongoExplain => MongoExplainPayload,
    MongoProfile => MongoProfilePayload,
    MongoProfileSet => MongoProfileSetPayload,
    MongoProfileEntries => MongoProfileEntriesPayload,
}

/// Checks the payload of a Git operation.
pub fn validate_git(operation: GitOperation, payload: Value) -> Result<Value> {
    check::<GitPayload>(operation, payload)
}

/// The TypeScript contract written to `src/app/application/payloads.ts`.
pub fn typescript_contract() -> String {
    let mut parts = vec![
        "// Generated from backend/crates/nexo-application/src/payloads.rs.\n\
         // Regenerate with `NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application`.\n\
         import type { ExecutionOperation } from './operations';\n"
            .to_string(),
        VariableRow::TYPESCRIPT.to_string(),
        ExecutionContext::TYPESCRIPT.to_string(),
        RunCursor::TYPESCRIPT.to_string(),
        FileAttachment::TYPESCRIPT.to_string(),
        CookieKey::TYPESCRIPT.to_string(),
        GitFile::TYPESCRIPT.to_string(),
        MongoConnection::TYPESCRIPT.to_string(),
    ];
    parts.extend(typescript_interfaces().into_iter().map(String::from));
    parts.push(GitPayload::TYPESCRIPT.to_string());
    parts.push(typescript_map());
    parts.push(
        "/** The payload of an operation. */\n\
         export type PayloadOf<O extends ExecutionOperation> = OperationPayloads[O];\n"
            .to_string(),
    );
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_request_payload_keeps_what_the_engine_reads() {
        let payload = json!({
            "workspace": "w1",
            "id": "tab-1",
            "request": {"name": "Get", "request": {"url": "https://x", "nexoCustom": 1}},
            "variables": [{"key": "a", "value": 1, "enabled": true, "description": "kept"}],
            "globals": [],
            "context": {"ancestors": [{"name": "API", "auth": {"type": "bearer"}}]},
            "timeout": 5000,
            "strictSSL": false,
            "followRedirects": true,
        });
        let checked = validate(Operation::Request, payload.clone()).unwrap();
        assert_eq!(checked, payload, "nothing is added, renamed or dropped");
        // Absent fields stay absent: the engine treats a missing setting as its default.
        let minimal = validate(Operation::Request, json!({"request": {"url": "x"}})).unwrap();
        assert_eq!(minimal, json!({"request": {"url": "x"}}));
    }

    #[test]
    fn refuses_unknown_fields_and_wrong_types_naming_the_field() {
        let error = validate(Operation::Request, json!({"strictSsl": false})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid request payload at strictSsl: unknown field `strictSsl`"),
            "{error}"
        );
        let error = validate(Operation::Request, json!({"strictSSL": "no"})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid request payload at strictSSL: invalid type"),
            "{error}"
        );
        let error = validate(
            Operation::Request,
            json!({"variables": [{"key": "a"}, {"value": 1}]}),
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("at variables[1]: missing field `key`"),
            "{error}"
        );
        let error = validate(Operation::Run, json!({"action": "pause"})).unwrap_err();
        assert!(
            error.to_string().contains("Invalid run payload at action"),
            "{error}"
        );
        let error = validate(Operation::Run, json!({"after": {"results": -1}})).unwrap_err();
        assert!(error.to_string().contains("at after.results"), "{error}");
        assert!(validate(Operation::Request, json!({"request": "https://x"})).is_err());
        assert!(validate(Operation::Run, json!([])).is_err());
    }

    #[test]
    fn every_operation_has_a_payload_type() {
        // An empty object is valid exactly when the operation has no required field.
        for operation in Operation::ALL {
            let result = validate(*operation, json!({}));
            let required = matches!(
                operation,
                Operation::Cancel
                    | Operation::RunPause
                    | Operation::RunResume
                    | Operation::Import
                    | Operation::ApiInspect
                    | Operation::ApiDiff
                    | Operation::RealtimeSend
                    | Operation::RealtimeClose
                    | Operation::RealtimePoll
                    | Operation::MockStop
                    | Operation::DatasetQuery
                    | Operation::DatasetSchema
                    | Operation::DatasetDelete
                    | Operation::OauthToken
                    | Operation::CookiesSet
                    | Operation::CookiesDelete
                    | Operation::PerformanceCancel
                    | Operation::MongoTest
                    | Operation::MongoDatabases
                    | Operation::MongoCollections
                    | Operation::MongoStats
                    | Operation::MongoFind
                    | Operation::MongoMore
                    | Operation::MongoCount
                    | Operation::MongoCancel
                    | Operation::MongoClose
                    | Operation::MongoInsert
                    | Operation::MongoUpdate
                    | Operation::MongoReplace
                    | Operation::MongoDelete
                    | Operation::MongoUndo
                    | Operation::MongoCollectionCreate
                    | Operation::MongoCollectionRename
                    | Operation::MongoCollectionDrop
                    | Operation::MongoDatabaseDrop
                    | Operation::MongoIndexes
                    | Operation::MongoIndexCreate
                    | Operation::MongoIndexHide
                    | Operation::MongoIndexDrop
                    | Operation::MongoExplain
                    | Operation::MongoProfile
                    | Operation::MongoProfileSet
                    | Operation::MongoProfileEntries
            );
            assert_eq!(result.is_err(), required, "{operation}");
            assert!(
                validate(
                    *operation,
                    json!({"unknown": 1, "id": "x", "content": "", "sql": "", "url": ""})
                )
                .is_err(),
                "{operation}"
            );
        }
    }

    #[test]
    fn checks_the_other_operation_groups() {
        let sign_in = json!({"action": "complete", "session": "s1", "url": "https://cb/?code=1"});
        assert_eq!(
            validate(Operation::Oauth2Authorize, sign_in.clone()).unwrap(),
            sign_in
        );
        let error = validate(Operation::Oauth2Authorize, json!({"action": "restart"})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("at action: unknown variant `restart`"),
            "{error}"
        );
        assert!(validate(Operation::Oauth2Tokens, json!({"action": "rename"})).is_err());
        let error = validate(Operation::OauthToken, json!({"fields": {}})).unwrap_err();
        assert!(error.to_string().contains("missing field `url`"), "{error}");
        let error = validate(Operation::MockStart, json!({"port": "8080"})).unwrap_err();
        assert!(
            error.to_string().contains("at port: invalid type"),
            "{error}"
        );
        let error = validate(Operation::RealtimeConnect, json!({"qos": 3000})).unwrap_err();
        assert!(error.to_string().contains("at qos"), "{error}");
        let grpc = json!({"url": "localhost:50051", "proto": "syntax", "service": "s", "method": "m",
                          "tls": false, "message": {"name": "Nexo"}, "metadata": []});
        assert_eq!(validate(Operation::Grpc, grpc.clone()).unwrap(), grpc);
        // Git: the files of an export and the branch or message of the others.
        let export = json!({"workspace": "w1", "files": [{"id": "c1", "value": {"item": []}}]});
        assert_eq!(
            validate_git(GitOperation::Export, export.clone()).unwrap(),
            export
        );
        let error = validate_git(GitOperation::Commit, json!({"mesage": "typo"})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Invalid commit payload at mesage"),
            "{error}"
        );
        let error =
            validate_git(GitOperation::Export, json!({"files": [{"id": "c1"}]})).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("at files[0]: missing field `value`"),
            "{error}"
        );
    }

    #[test]
    fn mongo_payloads_name_their_fields() {
        let test = json!({"workspace": "w1", "connection": {
            "uri": "mongodb://ana@db.test", "password": "{{vault:mongo}}", "caPem": "-----BEGIN"
        }});
        assert_eq!(validate(Operation::MongoTest, test.clone()).unwrap(), test);
        let error = validate(
            Operation::MongoTest,
            json!({"connection": {"uri": "mongodb://x", "tlsCAFile": "/etc/ca.pem"}}),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("at connection.tlsCAFile"),
            "{error}"
        );
        let error = validate(Operation::MongoTest, json!({"connection": {}})).unwrap_err();
        assert!(error.to_string().contains("missing field `uri`"), "{error}");
        let find = json!({
            "connection": {"uri": "mongodb://h"}, "id": "q1", "database": "shop",
            "collection": "orders", "filter": {"_id": {"$oid": "65a1b2c3d4e5f6a7b8c9d0e1"}},
            "sort": {"at": -1}, "hint": "at_1", "skip": 20, "limit": 0, "pageSize": 50,
        });
        assert_eq!(validate(Operation::MongoFind, find.clone()).unwrap(), find);
        // A filter is a document, never a script.
        let error = validate(
            Operation::MongoFind,
            json!({"connection": {"uri": "mongodb://h"}, "id": "q", "database": "d",
                "collection": "c", "filter": "this.a > 1"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("filter"), "{error}");
        let error = validate(
            Operation::MongoCount,
            json!({"connection": {"uri": "mongodb://h"}, "id": "q", "database": "d",
                "collection": "c", "projection": {}}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("projection"), "{error}");
        let more = json!({"cursor": "c1", "id": "q2", "pageSize": 20});
        assert_eq!(validate(Operation::MongoMore, more.clone()).unwrap(), more);
    }

    #[test]
    fn index_explain_and_profiler_payloads_name_their_fields() {
        let connection = json!({"uri": "mongodb://h"});
        let explain = json!({
            "connection": connection, "id": "e1", "database": "shop", "collection": "orders",
            "verbosity": "executionStats", "filter": {"status": "A"}, "sort": {"at": -1},
        });
        assert_eq!(
            validate(Operation::MongoExplain, explain.clone()).unwrap(),
            explain
        );
        let error = validate(
            Operation::MongoExplain,
            json!({"connection": connection, "id": "e1", "database": "d", "collection": "c",
                "verbosity": "allPlansExecution"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at verbosity"), "{error}");
        // A pipeline is a list of stages, never a script.
        let error = validate(
            Operation::MongoExplain,
            json!({"connection": connection, "id": "e1", "database": "d", "collection": "c",
                "pipeline": "db.c.aggregate([])"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at pipeline"), "{error}");
        let error = validate(
            Operation::MongoIndexCreate,
            json!({"connection": connection, "connectionId": "c1", "database": "d",
                "collection": "c", "keys": "a_1"}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at keys"), "{error}");
        let error = validate(
            Operation::MongoIndexDrop,
            json!({"connection": connection, "connectionId": "c1", "database": "d",
                "collection": "c", "name": "a_1"}),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("missing field `confirm`"),
            "{error}"
        );
        let error = validate(
            Operation::MongoProfileSet,
            json!({"connection": connection, "connectionId": "c1", "database": "d", "level": -1}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("at level"), "{error}");
    }

    #[test]
    fn run_payloads_start_and_poll_runs() {
        let start = json!({
            "collection": {"info": {"name": "C"}, "item": []},
            "variables": [], "globals": [], "data": [{"a": 1}, "x"],
            "iterations": 2, "globalTimeout": 60000, "strictSSL": true,
        });
        assert_eq!(validate(Operation::Run, start.clone()).unwrap(), start);
        let status = json!({"action": "status", "id": "r1", "after": {"results": 2, "logs": 1}});
        assert_eq!(validate(Operation::Run, status.clone()).unwrap(), status);
    }

    #[test]
    fn typescript_contract_is_current() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../src/app/application/payloads.ts");
        let expected = typescript_contract();
        if std::env::var_os("NEXO_UPDATE_CONTRACTS").is_some() {
            std::fs::write(&path, &expected).unwrap();
        }
        let current = std::fs::read_to_string(&path)
            .unwrap_or_default()
            .replace("\r\n", "\n");
        assert_eq!(
            current, expected,
            "payloads.ts is out of date; run NEXO_UPDATE_CONTRACTS=1 cargo test -p nexo-application"
        );
    }
}
