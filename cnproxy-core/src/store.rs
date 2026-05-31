//! Flow store — holds captured traffic for inspection.

use crate::flow::{Flow, FlowId, FlowSummary};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Thread-safe store for captured flows.
pub struct FlowStore {
    flows: Arc<RwLock<HashMap<FlowId, Flow>>>,
    order: Arc<RwLock<Vec<FlowId>>>,
}

impl FlowStore {
    pub fn new() -> Self {
        Self {
            flows: Arc::new(RwLock::new(HashMap::new())),
            order: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Add a new flow to the store.
    pub async fn add(&self, flow: Flow) {
        let id = flow.id.clone();
        let is_new = !self.flows.read().await.contains_key(&id);
        self.flows.write().await.insert(id.clone(), flow);
        if is_new {
            self.order.write().await.push(id);
        }
    }

    /// Update an existing flow.
    pub async fn update(&self, flow: Flow) {
        self.flows.write().await.insert(flow.id.clone(), flow);
    }

    /// Get a flow by ID.
    pub async fn get(&self, id: &str) -> Option<Flow> {
        self.flows.read().await.get(id).cloned()
    }

    /// List all flows as summaries (for the flow list UI).
    pub async fn list(&self) -> Vec<FlowSummary> {
        let order = self.order.read().await;
        let flows = self.flows.read().await;
        order
            .iter()
            .filter_map(|id| flows.get(id).map(|f| f.to_summary()))
            .collect()
    }

    /// Remove a flow by ID.
    pub async fn remove(&self, id: &str) -> Option<Flow> {
        let flow = self.flows.write().await.remove(id);
        if flow.is_some() {
            self.order.write().await.retain(|i| i != id);
        }
        flow
    }

    /// Clear all flows.
    pub async fn clear(&self) {
        self.flows.write().await.clear();
        self.order.write().await.clear();
    }

    /// Number of stored flows.
    pub async fn len(&self) -> usize {
        self.flows.read().await.len()
    }
}