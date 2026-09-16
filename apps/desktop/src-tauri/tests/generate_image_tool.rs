//! t0-8 M3: `generate_image` builtin tool.
//!
//! Exercised the same way `tests/agent_tools.rs` exercises the other builtin
//! tools — `execute_builtin_tool` against a manually built `AgentToolContext`,
//! no `AppState` or `StreamManager` needed. `ImageToolConfig` carries an
//! already-resolved `Box<dyn ProviderAdapter>`, so the fake adapter below
//! plugs in directly with no network call, mirroring how `agent_turn.rs`'s
//! `ScriptedAdapter` fakes chat rounds via `StreamManager`'s
//! `AdapterResolver` seam.

mod common;

use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use conduit_desktop::{
    agent_tools::{self, AgentToolContext, ImageToolConfig, GENERATE_IMAGE_TOOL},
    db::repository::{artifacts, conversations},
};
use futures::stream::Stream;
use provider_core::{
    schema::{ImageGenerationRequest, ImageGenerationResult, ProviderEvent, ProviderRequest},
    AdapterContext, ModelInfo, ProviderAdapter, ProviderError,
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// A `ProviderAdapter` whose `generate_image` returns a canned result (or
/// error) instead of calling out to a real provider. Every other trait
/// method either isn't exercised by this test or just needs to compile.
struct FakeImageAdapter {
    response: Result<ImageGenerationResult, ProviderError>,
    requests: Arc<Mutex<Vec<ImageGenerationRequest>>>,
}

#[async_trait]
impl ProviderAdapter for FakeImageAdapter {
    fn id(&self) -> &'static str {
        "fake-image-provider"
    }

    fn display_name(&self) -> &'static str {
        "Fake Image Provider"
    }

    async fn validate_credentials(&self, _ctx: &AdapterContext) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_models(&self, _ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn stream_chat(
        &self,
        _request: ProviderRequest,
        _ctx: AdapterContext,
        _cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        Err(provider_core::error::fatal(
            "stream_chat is not exercised by this test",
        ))
    }

    async fn generate_image(
        &self,
        request: ImageGenerationRequest,
        _ctx: &AdapterContext,
    ) -> Result<ImageGenerationResult, ProviderError> {
        self.requests.lock().unwrap().push(request);
        self.response.clone()
    }
}

fn fake_adapter_ctx() -> AdapterContext {
    AdapterContext {
        api_key: None,
        base_url: None,
        http: provider_core::transport::HttpClient::new(),
        local_only: false,
    }
}

/// Bytes that sniff as a real PNG (same fixture `image_generation.rs`'s own
/// unit tests use), so this test isn't relying on made-up bytes to stand in
/// for a real image payload.
const ONE_PIXEL_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

#[tokio::test]
async fn generate_image_writes_image_artifact() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();

    let requests = Arc::new(Mutex::new(Vec::new()));
    let adapter = FakeImageAdapter {
        response: Ok(ImageGenerationResult {
            bytes: ONE_PIXEL_PNG.to_vec(),
            mime_type: "image/png".to_string(),
        }),
        requests: requests.clone(),
    };

    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: Some("msg-1".to_string()),
        workspace: None,
        search: Default::default(),
        image: Some(ImageToolConfig {
            provider_id: "fake-image-provider".to_string(),
            model_id: "fake-model-1".to_string(),
            adapter: Box::new(adapter),
            adapter_ctx: fake_adapter_ctx(),
        }),
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-1",
        "req-1",
        GENERATE_IMAGE_TOOL,
        &json!({
            "prompt": "a red circle on a white background",
            "size": "1024x1024",
        }),
    )
    .await
    .expect("tool runs");

    assert!(!result.is_error, "tool call should succeed: {result:?}");

    // The adapter received exactly the request the tool was supposed to send:
    // the *configured* image model, not anything the caller could override.
    // Scoped to a block (rather than an explicit `drop`) so the `MutexGuard`
    // provably doesn't span the `.await` below.
    {
        let sent = requests.lock().unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].model_id, "fake-model-1");
        assert_eq!(sent[0].prompt, "a red circle on a white background");
        assert_eq!(sent[0].size.as_deref(), Some("1024x1024"));
    }

    let artifact_id = result
        .output
        .get("artifact_id")
        .and_then(|v| v.as_str())
        .expect("artifact id");

    let artifact = artifacts::get(&pool, &enc, artifact_id)
        .await
        .unwrap()
        .expect("artifact exists");

    assert_eq!(artifact.kind, "image");
    assert_eq!(artifact.source_message_id.as_deref(), Some("msg-1"));
    assert_eq!(artifact.mime_type.as_deref(), Some("image/png"));
    assert!(
        artifact.size_bytes.unwrap_or(0) > 0,
        "artifact should have non-empty content"
    );

    let content_path = artifact.content_path.as_deref().expect("file-backed");
    assert!(content_path.ends_with(".png"), "{content_path}");
    let blob = artifacts::resolve_artifact_path(artifacts_dir.path(), content_path);
    let on_disk = std::fs::read(&blob).expect("blob written to disk");
    assert_eq!(on_disk, ONE_PIXEL_PNG);
}

#[tokio::test]
async fn generate_image_without_provider_support_fails_clearly_and_writes_nothing() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();

    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
        workspace: None,
        search: Default::default(),
        // No image support configured — the provider (e.g. Anthropic, Ollama)
        // has no default image model.
        image: None,
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-2",
        "req-2",
        GENERATE_IMAGE_TOOL,
        &json!({ "prompt": "a red circle" }),
    )
    .await
    .expect("tool call is recorded even though it fails");

    assert!(result.is_error);
    let error = result
        .output
        .get("error")
        .and_then(|v| v.as_str())
        .expect("error message");
    assert!(
        error.contains("not available") || error.contains("no configured image model"),
        "error should explain the provider has no image support: {error}"
    );

    // No artifact was created for this conversation.
    let listed = artifacts::list(&pool, &conv.id).await.unwrap();
    assert!(
        listed.is_empty(),
        "no artifact should be written on failure"
    );
}

#[tokio::test]
async fn generate_image_provider_error_fails_clearly_and_writes_nothing() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();

    let adapter = FakeImageAdapter {
        response: Err(provider_core::error::fatal("the model refused the prompt")),
        requests: Arc::new(Mutex::new(Vec::new())),
    };

    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
        workspace: None,
        search: Default::default(),
        image: Some(ImageToolConfig {
            provider_id: "fake-image-provider".to_string(),
            model_id: "fake-model-1".to_string(),
            adapter: Box::new(adapter),
            adapter_ctx: fake_adapter_ctx(),
        }),
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-3",
        "req-3",
        GENERATE_IMAGE_TOOL,
        &json!({ "prompt": "a red circle" }),
    )
    .await
    .expect("tool call is recorded even though it fails");

    assert!(result.is_error);
    let error = result
        .output
        .get("error")
        .and_then(|v| v.as_str())
        .expect("error message");
    assert!(error.contains("the model refused the prompt"), "{error}");

    let listed = artifacts::list(&pool, &conv.id).await.unwrap();
    assert!(
        listed.is_empty(),
        "a failed generation should not leave behind an orphan artifact"
    );
}
