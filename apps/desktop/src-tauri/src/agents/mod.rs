//! Agents the user defines once and uses as helpers in any workflow, and hands
//! work to from chat.
//!
//! - `library`: the stored agents, how a workflow's references to them are
//!   filled in (`resolve`), what makes one valid, and the starter agents
//! - `handoff`: handing work to an agent (the `ask_` tools), shared by
//!   workflows and chat, and running chat turns as an agent

pub mod handoff;
pub mod library;
