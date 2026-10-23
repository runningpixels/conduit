//! The agent library: agents defined once and used as helpers in any
//! workflow (`agents::library`).

mod common;

use conduit_desktop::agents::library::{self, LibraryAgent};
use conduit_desktop::db::repository::workflows as workflow_repo;
use conduit_desktop::encryption::Encryption;
use conduit_desktop::workflows::definition::AgentDef;
use serde_json::{json, Value};
use sqlx::SqlitePool;

fn agent(value: Value) -> AgentDef {
    serde_json::from_value(value).expect("an agent")
}

fn named(name: &str) -> AgentDef {
    agent(json!({ "id": "", "name": name, "instructions": "Do the job." }))
}

async fn setup() -> (SqlitePool, Encryption) {
    (common::setup_pool().await, common::setup_encryption())
}

async fn add(pool: &SqlitePool, enc: &Encryption, value: Value) -> LibraryAgent {
    library::create(pool, enc, agent(value))
        .await
        .expect("it saves")
}

fn ids(list: &[LibraryAgent]) -> Vec<&str> {
    list.iter().map(|a| a.agent.id.as_str()).collect()
}

async fn save_workflow(
    pool: &SqlitePool,
    enc: &Encryption,
    name: &str,
    definition: Value,
) -> String {
    workflow_repo::create(pool, enc, name, None, &definition)
        .await
        .unwrap()
        .id
}

fn using(helpers: Value) -> Value {
    json!({
        "agents": helpers,
        "steps": [{ "id": "go", "type": "agent", "prompt": "Go", "agents": [] }]
    })
}

#[tokio::test]
async fn a_new_agent_gets_an_id_from_its_name_and_a_suffix_when_it_is_taken() {
    let (pool, enc) = setup().await;
    let first = library::create(&pool, &enc, named("Trip planner"))
        .await
        .unwrap();
    assert_eq!(first.agent.id, "trip_planner");
    assert!(first.used_by.is_empty());
    let second = library::create(&pool, &enc, named("  Trip   planner! "))
        .await
        .unwrap();
    assert_eq!(second.agent.id, "trip_planner_2");
    assert_eq!(second.agent.name, "Trip   planner!");
    let third = library::create(&pool, &enc, named("Trip planner"))
        .await
        .unwrap();
    assert_eq!(third.agent.id, "trip_planner_3");
    let nothing = library::create(&pool, &enc, named("!!!")).await.unwrap();
    assert_eq!(nothing.agent.id, "agent");
    let long = library::create(&pool, &enc, named(&"abc ".repeat(12)))
        .await
        .unwrap();
    assert!(long.agent.id.len() <= 40 && long.agent.id.starts_with("abc_abc"));
    assert!(!long.agent.id.ends_with('_'));
    // A named id that is taken gets a suffix as well.
    let mut again = named("Other");
    again.id = "trip_planner".into();
    let again = library::create(&pool, &enc, again).await.unwrap();
    assert_eq!(again.agent.id, "trip_planner_4");
}

#[tokio::test]
async fn an_agent_is_updated_in_place_and_must_exist() {
    let (pool, enc) = setup().await;
    let saved = add(
        &pool,
        &enc,
        json!({ "id": "writer", "name": "Writer", "instructions": "Write." }),
    )
    .await;
    let changed = library::update(
        &pool,
        &enc,
        agent(json!({ "id": "writer", "name": "Writer", "instructions": "Write well.", "tools": ["calculator"], "maxTokens": 5000 })),
    )
    .await
    .unwrap();
    assert_eq!(changed.agent.instructions, "Write well.");
    assert_eq!(changed.agent.tools, vec!["calculator".to_string()]);
    assert_eq!(changed.agent.max_tokens, Some(5000));
    assert_eq!(changed.created_at, saved.created_at);

    let missing = library::update(
        &pool,
        &enc,
        agent(json!({ "id": "ghost", "name": "Ghost", "instructions": "Boo." })),
    )
    .await
    .unwrap_err();
    assert_eq!(missing, "That agent no longer exists.");
}

#[tokio::test]
async fn problems_are_reported_in_plain_words() {
    let (pool, enc) = setup().await;
    // The same wording a workflow's helpers get.
    let bad = library::create(
        &pool,
        &enc,
        agent(json!({ "id": "", "name": "", "instructions": "", "tools": ["teleport"], "maxTokens": 5 })),
    )
    .await
    .unwrap_err();
    assert!(bad.contains("needs a name."), "{bad}");
    assert!(bad.contains("needs instructions"), "{bad}");
    assert!(bad.contains("can't use the tool \"teleport\""), "{bad}");
    assert!(
        bad.contains("a task can use 1000 to 300000 tokens"),
        "{bad}"
    );

    // An agent that doesn't exist, itself, twice.
    let problems = library::validate(
        &pool,
        &enc,
        agent(json!({ "id": "a", "name": "A", "instructions": "x", "agents": ["nobody", "a", "nobody"] })),
    )
    .await
    .unwrap();
    assert!(problems
        .iter()
        .any(|p| p == "\u{201c}A\u{201d} hands work to \u{201c}nobody\u{201d}, which isn\u{2019}t one of your agents."), "{problems:?}");
    assert!(
        problems
            .iter()
            .any(|p| p.contains("can\u{2019}t hand work to itself")),
        "{problems:?}"
    );
    assert!(
        problems.iter().any(|p| p.contains("lists an agent twice")),
        "{problems:?}"
    );

    // A copy of another agent can't be saved as an agent.
    let copy = library::validate(
        &pool,
        &enc,
        agent(json!({ "id": "a", "name": "A", "instructions": "x", "library": "b" })),
    )
    .await
    .unwrap();
    assert_eq!(copy.len(), 1, "{copy:?}");

    // A new agent is checked under the id it would get.
    let fine = library::validate(&pool, &enc, named("Fresh"))
        .await
        .unwrap();
    assert!(fine.is_empty(), "{fine:?}");
    // Computer use is allowed: the workflow that uses it needs a folder.
    let computer = library::validate(
        &pool,
        &enc,
        agent(
            json!({ "id": "", "name": "Operator", "instructions": "Work.", "tools": ["computer"] }),
        ),
    )
    .await
    .unwrap();
    assert!(computer.is_empty(), "{computer:?}");
}

#[tokio::test]
async fn handing_work_round_in_a_circle_or_too_far_is_refused() {
    let (pool, enc) = setup().await;
    add(
        &pool,
        &enc,
        json!({ "id": "c", "name": "C", "instructions": "x" }),
    )
    .await;
    add(
        &pool,
        &enc,
        json!({ "id": "b", "name": "B", "instructions": "x", "agents": ["c"] }),
    )
    .await;

    // A hands work to B, which hands work on to C: one hand-off too many.
    let deep = library::create(
        &pool,
        &enc,
        agent(json!({ "id": "a", "name": "A", "instructions": "x", "agents": ["b"] })),
    )
    .await
    .unwrap_err();
    assert_eq!(
        deep,
        "\u{201c}A\u{201d} hands work to \u{201c}B\u{201d}, which hands work on too. An agent\u{2019}s helpers can\u{2019}t have helpers of their own."
    );

    // Giving a helper helpers of its own breaks the agent that uses it.
    let breaks_b = library::update(
        &pool,
        &enc,
        agent(json!({ "id": "c", "name": "C", "instructions": "x", "agents": ["b"] })),
    )
    .await
    .unwrap_err();
    assert!(breaks_b.contains("in a circle"), "{breaks_b}");
    assert!(breaks_b.contains("which hands work on too"), "{breaks_b}");

    add(
        &pool,
        &enc,
        json!({ "id": "d", "name": "D", "instructions": "x" }),
    )
    .await;
    let circle = library::update(
        &pool,
        &enc,
        agent(json!({ "id": "d", "name": "D", "instructions": "x", "agents": ["c"] })),
    )
    .await;
    assert!(circle.is_ok(), "D may hand work to C {circle:?}");
}

#[tokio::test]
async fn the_list_is_sorted_by_name_and_says_which_workflows_use_each_agent() {
    let (pool, enc) = setup().await;
    add(
        &pool,
        &enc,
        json!({ "id": "b", "name": "beta", "instructions": "x" }),
    )
    .await;
    add(
        &pool,
        &enc,
        json!({ "id": "a", "name": "Gamma", "instructions": "x" }),
    )
    .await;
    add(
        &pool,
        &enc,
        json!({ "id": "c", "name": "Alpha", "instructions": "x", "agents": ["b"] }),
    )
    .await;
    let direct = save_workflow(
        &pool,
        &enc,
        "Direct",
        using(json!([{ "id": "a", "library": "a" }])),
    )
    .await;
    // Reaches beta only through Alpha.
    let through = save_workflow(
        &pool,
        &enc,
        "Through",
        using(json!([{ "id": "c", "library": "c" }])),
    )
    .await;
    // An inline helper that has the same id isn't a use.
    save_workflow(
        &pool,
        &enc,
        "Inline",
        using(json!([{ "id": "a", "name": "Mine", "instructions": "Own." }])),
    )
    .await;

    let list = library::list(&pool, &enc).await.unwrap();
    assert_eq!(ids(&list), vec!["c", "b", "a"], "Alpha, beta, Gamma");
    let users = |i: usize| -> Vec<&str> {
        list[i]
            .used_by
            .iter()
            .map(|u| u.workflow_id.as_str())
            .collect()
    };
    assert_eq!(users(0), vec![through.as_str()]);
    assert_eq!(users(1), vec![through.as_str()]);
    assert_eq!(users(2), vec![direct.as_str()]);
    assert_eq!(list[2].used_by[0].workflow_name, "Direct");
}

#[tokio::test]
async fn resolving_fills_in_references_and_follows_hand_offs() {
    let (pool, enc) = setup().await;
    add(&pool, &enc, json!({ "id": "writer", "name": "Writer", "instructions": "Write.", "tools": ["calculator"] })).await;
    add(&pool, &enc, json!({ "id": "lead", "name": "Lead", "instructions": "Plan.", "agents": ["writer"], "maxTokens": 4000 })).await;
    let definition = using(json!([
        { "id": "lead", "library": "lead" },
        { "id": "own", "name": "Own", "instructions": "Mine." },
    ]));
    let resolved = library::resolve_value(&pool, &enc, &definition)
        .await
        .unwrap();
    let helpers = resolved["agents"].as_array().unwrap();
    assert_eq!(helpers.len(), 3);
    assert_eq!(helpers[0]["name"], "Lead");
    assert_eq!(helpers[0]["agents"], json!(["writer"]));
    assert_eq!(helpers[0]["maxTokens"], 4000);
    assert_eq!(helpers[0]["library"], "lead");
    assert_eq!(
        helpers[1], definition["agents"][1],
        "inline helpers stay as written"
    );
    assert_eq!(helpers[2]["id"], "writer");
    assert_eq!(helpers[2]["tools"], json!(["calculator"]));
    assert_eq!(helpers[2]["library"], "writer");
    assert!(conduit_desktop::workflows::definition::check_value(&resolved).is_ok());

    // A helper of the workflow's own with the same id as one pulled in is
    // kept, and the usual duplicate check reports the clash.
    let clash = using(json!([
        { "id": "lead", "library": "lead" },
        { "id": "writer", "name": "Mine", "instructions": "Own." },
    ]));
    let resolved = library::resolve_value(&pool, &enc, &clash).await.unwrap();
    let problems = conduit_desktop::workflows::definition::check_value(&resolved).unwrap_err();
    assert_eq!(resolved["agents"].as_array().unwrap().len(), 3);
    assert!(
        problems.contains("Two helpers are called \"writer\"."),
        "{problems}"
    );
}

#[tokio::test]
async fn deleting_an_agent_gives_each_workflow_its_own_copy() {
    let (pool, enc) = setup().await;
    add(&pool, &enc, json!({ "id": "writer", "name": "Writer", "instructions": "Write.", "tools": ["calculator"] })).await;
    add(
        &pool,
        &enc,
        json!({ "id": "lead", "name": "Lead", "instructions": "Plan.", "agents": ["writer"] }),
    )
    .await;
    let direct = save_workflow(
        &pool,
        &enc,
        "Direct",
        using(json!([{ "id": "writer", "library": "writer" }])),
    )
    .await;
    let through = save_workflow(
        &pool,
        &enc,
        "Through",
        using(json!([{ "id": "lead", "library": "lead" }])),
    )
    .await;
    let unrelated = save_workflow(&pool, &enc, "Unrelated", using(json!([]))).await;

    let changed = library::delete(&pool, &enc, "writer").await.unwrap();
    assert_eq!(changed, 1);

    let stored = |id: String| {
        let (pool, enc) = (pool.clone(), &enc);
        async move { workflow_repo::get(&pool, enc, &id).await.unwrap().unwrap() }
    };
    let direct = stored(direct).await;
    assert_eq!(direct.version, 2);
    assert_eq!(
        direct.definition["agents"],
        json!([{
            "id": "writer", "name": "Writer", "instructions": "Write.", "tools": ["calculator"]
        }])
    );
    let through = stored(through).await;
    assert_eq!(through.version, 1, "it only reached the agent through Lead");
    assert_eq!(stored(unrelated).await.version, 1);

    let remaining = library::list(&pool, &enc).await.unwrap();
    assert_eq!(ids(&remaining), vec!["lead"]);
    assert!(
        remaining[0].agent.agents.is_empty(),
        "Lead stopped handing work to Writer"
    );
    assert_eq!(remaining[0].used_by.len(), 1);

    let gone = library::delete(&pool, &enc, "writer").await.unwrap_err();
    assert_eq!(gone, "That agent no longer exists.");
}

#[tokio::test]
async fn a_copy_keeps_handing_work_to_the_agents_the_original_did() {
    let (pool, enc) = setup().await;
    add(
        &pool,
        &enc,
        json!({ "id": "writer", "name": "Writer", "instructions": "Write." }),
    )
    .await;
    add(
        &pool,
        &enc,
        json!({ "id": "lead", "name": "Lead", "instructions": "Plan.", "agents": ["writer"] }),
    )
    .await;
    let id = save_workflow(
        &pool,
        &enc,
        "Through",
        using(json!([{ "id": "lead", "library": "lead" }])),
    )
    .await;

    assert_eq!(library::delete(&pool, &enc, "lead").await.unwrap(), 1);
    let record = workflow_repo::get(&pool, &enc, &id).await.unwrap().unwrap();
    assert_eq!(
        record.definition["agents"],
        json!([
            { "id": "lead", "name": "Lead", "instructions": "Plan.", "tools": [], "agents": ["writer"] },
            { "id": "writer", "library": "writer" },
        ])
    );
    let resolved = library::resolve_value(&pool, &enc, &record.definition)
        .await
        .unwrap();
    assert_eq!(resolved["agents"][1]["name"], "Writer");
}

#[tokio::test]
async fn the_starter_agents_are_added_once() {
    let (pool, enc) = setup().await;
    assert!(library::list(&pool, &enc).await.unwrap().is_empty());
    assert_eq!(library::seed_starters(&pool, &enc).await.unwrap(), 4);

    let list = library::list(&pool, &enc).await.unwrap();
    assert_eq!(
        ids(&list),
        vec!["analyst", "researcher", "reviewer", "writer"]
    );
    let names: Vec<&str> = list.iter().map(|a| a.agent.name.as_str()).collect();
    assert_eq!(
        names,
        vec!["Data analyst", "Researcher", "Reviewer", "Writer"]
    );
    let tools = |id: &str| {
        list.iter()
            .find(|a| a.agent.id == id)
            .unwrap()
            .agent
            .tools
            .clone()
    };
    assert_eq!(tools("researcher"), vec!["web_search", "web_fetch"]);
    assert_eq!(tools("analyst"), vec!["calculator"]);
    assert!(tools("writer").is_empty());
    for starter in library::starters() {
        assert!(library::check(&starter, &[]).is_ok(), "{}", starter.id);
    }

    // Deleting one doesn't bring it back, and nothing is added twice.
    library::delete(&pool, &enc, "writer").await.unwrap();
    assert_eq!(library::seed_starters(&pool, &enc).await.unwrap(), 0);
    assert_eq!(library::list(&pool, &enc).await.unwrap().len(), 3);
}

#[tokio::test]
async fn a_starter_the_user_already_has_is_kept_as_it_is() {
    let (pool, enc) = setup().await;
    add(
        &pool,
        &enc,
        json!({ "id": "writer", "name": "My writer", "instructions": "Mine." }),
    )
    .await;
    assert_eq!(library::seed_starters(&pool, &enc).await.unwrap(), 3);
    let list = library::list(&pool, &enc).await.unwrap();
    let writer = list.iter().find(|a| a.agent.id == "writer").unwrap();
    assert_eq!(writer.agent.name, "My writer");
}
