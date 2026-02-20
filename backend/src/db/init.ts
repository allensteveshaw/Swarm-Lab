import { getSql } from "./client";

export async function ensureSchema() {
  const sql = getSql();
  await sql/* sql */ `
    create table if not exists workspaces (
      id uuid primary key,
      name text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists agents (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      role text not null,
      parent_id uuid null,
      model_profile_id uuid null,
      llm_history text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    alter table agents
      add column if not exists model_profile_id uuid null,
      add column if not exists kind text not null default 'worker',
      add column if not exists auto_run_enabled boolean not null default true,
      add column if not exists origin_type text null,
      add column if not exists origin_id uuid null,
      add column if not exists deleted_at timestamptz null,
      add column if not exists last_active_at timestamptz null;
  `;

  await sql/* sql */ `
    create table if not exists model_profiles (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      name text not null,
      provider text not null,
      base_url text null,
      model text not null,
      api_key text null,
      headers_json text null,
      is_default boolean not null default false,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    do $$
    begin
      if not exists (
        select 1
        from pg_constraint
        where conname = 'agents_model_profile_id_fkey'
      ) then
        alter table agents
          add constraint agents_model_profile_id_fkey
          foreign key (model_profile_id) references model_profiles(id)
          on delete set null;
      end if;
    end
    $$;
  `;

  await sql/* sql */ `
    create table if not exists groups (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      name text null,
      kind text not null default 'chat',
      deleted_at timestamptz null,
      context_tokens integer default 0,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    alter table groups
      add column if not exists kind text not null default 'chat',
      add column if not exists deleted_at timestamptz null;
  `;

  await sql/* sql */ `
    create table if not exists group_members (
      group_id uuid not null references groups(id),
      user_id uuid not null,
      last_read_message_id uuid null,
      joined_at timestamptz not null,
      primary key (group_id, user_id)
    );
  `;

  await sql/* sql */ `
    create table if not exists messages (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      group_id uuid not null references groups(id),
      sender_id uuid not null,
      content_type text not null,
      content text not null,
      send_time timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists task_runs (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      root_group_id uuid not null references groups(id),
      owner_agent_id uuid not null references agents(id),
      goal text not null,
      status text not null,
      stop_reason text null,
      budget_json text not null,
      metrics_json text not null,
      summary_message_id uuid null,
      start_at timestamptz not null,
      deadline_at timestamptz not null,
      stopped_at timestamptz null,
      created_at timestamptz not null,
      updated_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists task_reviews (
      task_id uuid primary key references task_runs(id),
      workspace_id uuid not null references workspaces(id),
      review_json text not null,
      narrative_text text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists undercover_games (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      status text not null,
      phase text not null,
      round_no integer not null default 1,
      civilian_word text not null,
      undercover_word text not null,
      human_agent_id uuid not null,
      group_id uuid not null,
      current_turn_player_id uuid null,
      winner_side text null,
      is_tiebreak boolean not null default false,
      state_json text not null,
      started_at timestamptz not null,
      ended_at timestamptz null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists undercover_players (
      game_id uuid not null references undercover_games(id),
      agent_id uuid not null references agents(id),
      is_human boolean not null default false,
      role text not null,
      alive boolean not null default true,
      seat_no integer not null,
      strategy_key text null,
      decode_json text null,
      memory_json text null,
      emotion_state text null,
      primary key (game_id, agent_id)
    );
  `;

  await sql/* sql */ `
    alter table undercover_players
      add column if not exists strategy_key text null,
      add column if not exists decode_json text null,
      add column if not exists memory_json text null,
      add column if not exists emotion_state text null;
  `;

  await sql/* sql */ `
    create table if not exists undercover_round_events (
      id uuid primary key,
      game_id uuid not null references undercover_games(id),
      round_no integer not null,
      phase text not null,
      event_type text not null,
      actor_agent_id uuid null,
      target_agent_id uuid null,
      payload_json text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists undercover_votes (
      id uuid primary key,
      game_id uuid not null references undercover_games(id),
      round_no integer not null,
      voter_agent_id uuid not null,
      target_agent_id uuid not null,
      is_tiebreak boolean not null default false,
      reason text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists undercover_reviews (
      game_id uuid primary key references undercover_games(id),
      summary_json text not null,
      narrative_text text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists werewolf_games (
      id uuid primary key,
      workspace_id uuid not null references workspaces(id),
      status text not null,
      phase text not null,
      round_no integer not null default 1,
      human_agent_id uuid not null,
      group_id uuid not null,
      current_turn_player_id uuid null,
      winner_side text null,
      state_json text not null,
      started_at timestamptz not null,
      ended_at timestamptz null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists werewolf_players (
      game_id uuid not null references werewolf_games(id),
      agent_id uuid not null references agents(id),
      is_human boolean not null default false,
      role text not null,
      alive boolean not null default true,
      seat_no integer not null,
      strategy_key text null,
      decode_json text null,
      memory_json text null,
      emotion_state text null,
      primary key (game_id, agent_id)
    );
  `;

  await sql/* sql */ `
    create table if not exists werewolf_round_events (
      id uuid primary key,
      game_id uuid not null references werewolf_games(id),
      round_no integer not null,
      phase text not null,
      event_type text not null,
      actor_agent_id uuid null,
      target_agent_id uuid null,
      payload_json text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists werewolf_votes (
      id uuid primary key,
      game_id uuid not null references werewolf_games(id),
      round_no integer not null,
      voter_agent_id uuid not null,
      target_agent_id uuid not null,
      is_tiebreak boolean not null default false,
      reason text not null,
      created_at timestamptz not null
    );
  `;

  await sql/* sql */ `
    create table if not exists werewolf_reviews (
      game_id uuid primary key references werewolf_games(id),
      summary_json text not null,
      narrative_text text not null,
      created_at timestamptz not null
    );
  `;
}
