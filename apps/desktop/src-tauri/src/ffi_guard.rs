//! Panic containment for `extern "system"` callbacks (security review
//! 2026-08-08, finding "unsafe FFI / panic safety"; see
//! docs/security-review.md).
//!
//! A Rust panic unwinding across a non-unwind FFI boundary was undefined
//! behavior before Rust 1.81 and is a guaranteed process abort from 1.81 on
//! (`Cargo.toml` pins `rust-version = "1.81"` accordingly). Either outcome
//! would take the whole window manager down because one WinEvent / EnumWindows
//! / wndproc callback hit a bug — e.g. a panic inside tauri's `Emitter::emit`
//! internals, which are outside this crate's control.
//!
//! Every `unsafe extern "system"` callback in the crate therefore runs its
//! Rust body through [`guard`]: the panic is caught *inside* the callback,
//! logged, and a caller-supplied safe default is returned to the OS instead.

use std::panic::{catch_unwind, AssertUnwindSafe};

/// Run `f`, catching any panic so it can never unwind (or abort) across the
/// enclosing `extern "system"` boundary. On panic the payload is logged with
/// `context` (which OS callback it happened in) and `default` is returned.
///
/// `AssertUnwindSafe` is sound here: the process-global state the callbacks
/// touch lives behind `Mutex`es that are locked with
/// `unwrap_or_else(|p| p.into_inner())` everywhere, so a poisoned lock never
/// cascades.
pub fn guard<T>(context: &str, default: T, f: impl FnOnce() -> T) -> T {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => value,
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic payload".to_string());
            log::error!("panic caught at FFI boundary in {context}: {msg}");
            default
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_the_closure_result_through() {
        assert_eq!(guard("test", 0, || 7), 7);
        assert_eq!(guard("test", false, || true), true);
    }

    #[test]
    fn returns_the_default_when_the_closure_panics() {
        assert_eq!(guard("test", 42, || panic!("boom")), 42);
    }

    #[test]
    fn catches_string_and_non_str_panic_payloads() {
        // &str payload
        assert_eq!(guard("test", -1, || panic!("static str")), -1);
        // String payload (formatted)
        let n = 3;
        assert_eq!(guard("test", -1, || panic!("formatted {n}")), -1);
        // Arbitrary payload via panic_any
        assert_eq!(
            guard("test", -1, || std::panic::panic_any(std::io::ErrorKind::Other)),
            -1
        );
    }

    #[test]
    fn state_mutations_before_the_panic_are_kept() {
        // The guard only contains the unwind; it does not roll anything back.
        let mut hits = 0;
        let out = guard("test", (), || {
            hits += 1;
            panic!("after mutation");
        });
        assert_eq!(out, ());
        assert_eq!(hits, 1);
    }
}
