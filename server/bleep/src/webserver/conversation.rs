use anyhow::{Context, Result};
use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Extension, Json,
};
use chrono::NaiveDateTime;
use reqwest::StatusCode;
use std::fmt;
use tracing::info;
use uuid::Uuid;

use crate::{
    agent::{exchange::Exchange, Project},
    db::SqlDb,
    repo::RepoRef,
    webserver::{self, middleware::User, Error, ErrorKind},
    Application,
};

#[derive(Clone)]
pub struct Conversation {
    pub exchanges: Vec<Exchange>,
    pub thread_id: Uuid,
    pub project_id: i64,
}

impl Conversation {
    pub fn new(project_id: i64) -> Self {
        Self {
            exchanges: Vec::new(),
            thread_id: Uuid::new_v4(),
            project_id,
        }
    }

    pub async fn store(&self, db: &SqlDb, user_id: &str) -> Result<()> {
        let mut transaction = db.begin().await?;

        // Delete the old conversation for simplicity. This also deletes all its messages.
        sqlx::query! {
            "DELETE FROM conversations
            WHERE thread_id = ? AND EXISTS (
                SELECT p.id
                FROM projects p
                WHERE p.id = project_id AND p.user_id = ?
            )",
            self.thread_id,
            user_id,
        }
        .execute(&mut transaction)
        .await?;

        let title = self
            .exchanges
            .first()
            .and_then(|list| list.query())
            .and_then(|q| q.split('\n').next().map(|s| s.to_string()))
            .context("couldn't find conversation title")?;

        let exchanges = serde_json::to_string(&self.exchanges)?;
        let thread_id = self.thread_id.to_string();

        sqlx::query! {
            "INSERT INTO conversations (
                thread_id, title, exchanges, project_id, created_at
            )
            VALUES (?, ?, ?, ?, strftime('%s', 'now'))",
            thread_id,
            title,
            exchanges,
            self.project_id,
        }
        .execute(&mut transaction)
        .await?;

        transaction.commit().await?;

        Ok(())
    }

    pub async fn load(
        db: &SqlDb,
        user_id: &str,
        project_id: i64,
        conversation_id: i64,
    ) -> webserver::Result<Self> {
        let row = sqlx::query! {
            "SELECT c.exchanges, c.thread_id
            FROM conversations c
            JOIN projects p ON p.id = c.project_id AND p.user_id = ?
            WHERE c.project_id = ? AND c.id = ?",
            user_id,
            project_id,
            conversation_id,
        }
        .fetch_optional(db.as_ref())
        .await?
        .ok_or_else(|| Error::not_found("conversation not found"))?;

        let exchanges = serde_json::from_str(&row.exchanges).map_err(Error::internal)?;

        Ok(Self {
            exchanges,
            thread_id: row.thread_id.parse().map_err(Error::internal)?,
            project_id,
        })
    }
}

#[derive(Hash, PartialEq, Eq, Clone)]
pub struct ConversationId {
    pub conversation_id: i64,
    pub project_id: i64,
    pub user_id: String,
}

#[derive(serde::Serialize)]
pub struct ConversationPreview {
    pub id: i64,
    pub created_at: i64,
    pub title: String,
}

pub(in crate::webserver) async fn list(
    Extension(user): Extension<User>,
    State(app): State<Application>,
    Path(project_id): Path<i64>,
) -> webserver::Result<impl IntoResponse> {
    let db = app.sql.as_ref();
    let user_id = user
        .username()
        .ok_or_else(|| Error::user("missing user ID"))?;

    let conversations = sqlx::query_as! {
        ConversationPreview,
        "SELECT c.id as 'id!', c.created_at, c.title \
        FROM conversations c \
        JOIN projects p ON p.id = c.project_id AND p.user_id = ? \
        WHERE p.id = ?
        ORDER BY c.created_at DESC",
        user_id,
        project_id,
    }
    .fetch_all(db)
    .await
    .map_err(Error::internal)?;

    Ok(Json(conversations))
}

pub(in crate::webserver) async fn delete(
    Extension(user): Extension<User>,
    State(app): State<Application>,
    Path((project_id, conversation_id)): Path<(i64, i64)>,
) -> webserver::Result<()> {
    let db = app.sql.as_ref();
    let user_id = user
        .username()
        .ok_or_else(|| Error::user("missing user ID"))?;

    let result = sqlx::query! {
        "DELETE FROM conversations
        WHERE id = $1 AND project_id = $2 AND EXISTS (
            SELECT p.id
            FROM projects p
            WHERE p.id = $2 AND p.user_id = $3
        )",
        conversation_id,
        project_id,
        user_id,
    }
    .execute(db)
    .await
    .map_err(Error::internal)?;

    if result.rows_affected() == 0 {
        return Err(Error::user("conversation not found").with_status(StatusCode::NOT_FOUND));
    }

    Ok(())
}

#[axum::debug_handler]
pub(in crate::webserver) async fn get(
    Extension(user): Extension<User>,
    Path((project_id, conversation_id)): Path<(i64, i64)>,
    State(app): State<Application>,
) -> webserver::Result<impl IntoResponse> {
    let user_id = user.username().ok_or_else(super::no_user_id)?;

    let exchanges = Conversation::load(&app.sql, user_id, project_id, conversation_id)
        .await?
        .exchanges;

    let exchanges = exchanges
        .into_iter()
        .map(|ex| ex.compressed())
        .collect::<Vec<_>>();

    Ok(Json(exchanges))
}
