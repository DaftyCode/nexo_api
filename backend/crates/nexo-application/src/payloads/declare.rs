//! The `payload!` macro every payload of this folder is declared with.

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
