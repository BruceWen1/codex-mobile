// -*- coding: utf-8 -*-
//! events.rs
//! Native Event Delivery Queue
//! =====================
//! Retains interactive requests and reports transcript gaps while the interface is paused.

use std::collections::VecDeque;

use serde_json::{Value, json};

/// Bounded native event queue.
/// Retains request identifiers while replacing old notifications under saturation.
pub(super) struct EventQueue {
    events: VecDeque<Value>,
    capacity: usize,
    skipped: usize,
}

impl EventQueue {
    /// Create an event queue with an explicit message capacity.
    ///
    /// Args:
    ///     capacity (usize): Maximum number of queued protocol messages.
    /// Returns:
    ///     EventQueue: Empty native event queue.
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            events: VecDeque::new(),
            capacity,
            skipped: 0,
        }
    }

    /// Queue a protocol event while preserving interactive requests.
    ///
    /// Args:
    ///     event (Value): Original notification or server request.
    /// Returns:
    ///     Result<(), Value>: Success or a request that must be failed back to the engine.
    pub(super) fn push(&mut self, event: Value) -> Result<(), Value> {
        // Keep one queued event per original request when an interface reattaches.
        if let Some(id) = event.get("id") {
            if self
                .events
                .iter()
                .any(|queued| queued.get("id") == Some(id))
            {
                return Ok(());
            }
        }
        // Reclaim an old notification before admitting another event at capacity.
        if self.events.len() >= self.capacity {
            let replaceable = self
                .events
                .iter()
                .position(|queued| queued.get("id").is_none());
            // Retain the pending interactive requests and report every dropped notification.
            if let Some(index) = replaceable {
                self.events.remove(index);
                self.skipped += 1;
            } else if event.get("id").is_none() {
                self.skipped += 1;
                return Ok(());
            } else {
                return Err(event);
            }
        }
        self.events.push_back(event);
        Ok(())
    }

    /// Remove a request already resolved or cancelled by the original engine.
    ///
    /// Args:
    ///     id (Value): Original string or integer request identifier.
    /// Returns:
    ///     (): A stale interaction is removed from the delivery queue.
    pub(super) fn resolve(&mut self, id: &Value) {
        self.events.retain(|event| event.get("id") != Some(id));
    }

    /// Deliver a bounded event batch and any pending transcript-gap marker.
    ///
    /// Args:
    ///     limit (usize): Maximum number of messages in this bridge response.
    /// Returns:
    ///     Value: Original ordered events with an explicit gap marker when needed.
    pub(super) fn drain(&mut self, limit: usize) -> Value {
        let mut events = Vec::new();
        // Restore authoritative history after any notifications were discarded.
        if self.skipped > 0 {
            events.push(json!({"method": "mobile/lagged", "params": {"skipped": self.skipped}}));
            self.skipped = 0;
        }
        // Bound each native bridge response while preserving event order.
        while events.len() < limit {
            // Finish the batch once every currently queued event has been delivered.
            let Some(event) = self.events.pop_front() else {
                break;
            };
            events.push(event);
        }
        Value::Array(events)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    /// Verify background saturation, interactive request retention, and cancellation.
    ///
    /// Args:
    ///     None.
    /// Returns:
    ///     (): Assertions verify bounded storage and explicit transcript recovery.
    #[test]
    fn retains_requests_and_reports_background_notification_gaps() {
        let mut queue = super::EventQueue::new(2);
        queue
            .push(json!({"id": 41, "method": "item/tool/call"}))
            .unwrap();
        queue
            .push(json!({"id": 41, "method": "item/tool/call"}))
            .unwrap();
        queue
            .push(json!({"method": "item/agentMessage/delta", "params": {"delta": "old"}}))
            .unwrap();
        queue.push(json!({"method": "turn/completed"})).unwrap();
        let batch = queue.drain(2);
        assert_eq!(batch[0]["method"], "mobile/lagged");
        assert_eq!(batch[1]["id"], 41);
        assert_eq!(queue.drain(2)[0]["method"], "turn/completed");
        // Fail overload explicitly when the queue contains only interactive requests.
        queue.push(json!({"id": 42})).unwrap();
        queue.push(json!({"id": 43})).unwrap();
        assert!(queue.push(json!({"id": 44})).is_err());
        queue.resolve(&json!(42));
        assert_eq!(queue.drain(2)[0]["id"], 43);
    }
}
