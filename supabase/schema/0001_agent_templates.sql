-- Two-layer agent prompt system: locked templates (agent_templates) + per-org
-- client-editable parameters (agents.client_params / draft_client_params).
-- No migration runner in this project — run manually in the Supabase SQL Editor.
-- Existing `agents.prompt` is left untouched: any row without `template_key`
-- keeps using it as-is (legacy path), so this is non-breaking for the 22
-- agents not yet migrated to the template system.

alter table agents add column if not exists template_key text;
alter table agents add column if not exists client_params jsonb not null default '{}'::jsonb;
alter table agents add column if not exists draft_client_params jsonb;

create table if not exists agent_templates (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  system_template text not null,
  use_cases jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Pilot template, extracted from the current "Assistant" prompt (identical
-- across all 10 orgs at the time of writing). The anti-hallucination
-- guardrail sentence and the persona line are preserved verbatim — only the
-- tone/length sentences become placeholders filled server-side from a fixed
-- enum (see api/_lib/shared.js TONE_INSTRUCTIONS / LENGTH_INSTRUCTIONS).
insert into agent_templates (key, name, system_template, use_cases) values (
  'assistant_generique',
  'Assistant polyvalent',
  $TEMPLATE$Tu es l'assistant IA de cette organisation. Tu aides l'équipe à retrouver des informations dans les documents fournis, répondre à des questions opérationnelles, et rédiger des messages ou des synthèses.

Appuie-toi en priorité sur les documents fournis et cite ta source [Source: nom_fichier]. Si l'information demandée n'est dans aucun document fourni, dis-le clairement plutôt que d'inventer une réponse.

{{length_instruction}}

Si la question fait suite à un échange précédent, appuie-toi sur ce contexte sans le répéter.

Réponds en français, {{tone_instruction}}.

{{enabled_use_case_snippets}}$TEMPLATE$,
  '[]'::jsonb
)
on conflict (key) do nothing;

update agents set template_key = 'assistant_generique' where name = 'Assistant';

-- New tables default to RLS disabled in Supabase, i.e. open read/write to
-- anyone with the publishable key. agent_templates holds the locked prompt
-- text — client code only ever needs to READ it (to list use_cases in the
-- customization form); all writes happen server-side with the service role
-- key (which bypasses RLS), so no write policy is added here on purpose.
alter table agent_templates enable row level security;
create policy "agent_templates read (authenticated)" on agent_templates
  for select to authenticated using (true);

-- IMPORTANT — verify manually in Supabase (Authentication > Policies) that
-- the existing `agents` table RLS does NOT allow direct client-side UPDATE
-- of client_params/draft_client_params/prompt/template_key/org_id. All
-- legitimate writes to those columns now go through api/agent-config.js
-- (service role key, bypasses RLS, does its own validation). If the current
-- UPDATE policy on `agents` is permissive (e.g. "org admins can update their
-- org's agents"), a technically capable user could otherwise call
-- `sb.from('agents').update(...)` directly from devtools and skip the
-- server-side validation entirely — the same class of gap we just closed on
-- /api/chat. Tighten it to deny client-side UPDATE on `agents` altogether
-- (nothing in the current UI performs one) if that's not already the case.
