//! Window actuation. Task 11 implements batched `DeferWindowPos` with hwnd
//! validation against the tracker's live eligible set (contract §C2 security
//! rule); until then the commands log and move nothing.

use crate::ipc::{ApplyLayout, Hwnd};

/// Contract §C2: `apply_layout(layout: ApplyLayout)`.
#[tauri::command]
pub fn apply_layout(layout: ApplyLayout) {
    log::debug!(
        "apply_layout stub: ignoring {} move(s)",
        layout.moves.len()
    );
}

/// Contract §C2: `focus_window(hwnd)`.
#[tauri::command]
pub fn focus_window(hwnd: Hwnd) {
    log::debug!("focus_window stub: ignoring hwnd {hwnd}");
}
