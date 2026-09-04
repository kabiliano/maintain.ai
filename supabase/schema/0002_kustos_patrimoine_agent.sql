-- Agent "Patrimoine" — expose les données Kustos (portefeuille physique +
-- financier) au chat WRZ Ops, via le pont api/kustos-tools.js.
-- Voir kustos/docs/manager-integration.md pour le plan complet et les
-- décisions prises (accès non filtré par org, lecture seule).
--
-- Comme 0001, pas de migration runner ici : à exécuter à la main dans le
-- Supabase SQL Editor du projet partagé.

-- Agent global (org_id null) : visible dans TOUTES les organisations, comme
-- Maintenance / Sécurité-HSE / Qualité / Procédures RH aujourd'hui (voir
-- loadAgents() dans index.html : `.or('org_id.is.null,org_id.eq.${orgId}')`).
-- Cohérent avec la décision "accès non filtré par organisation" — Kustos est
-- mono-utilisateur en V1, aucune notion d'org côté données à respecter ici.
insert into agents (org_id, name, description, prompt, icon, color, is_default)
values (
  null,
  'Patrimoine',
  'Suivi prédictif du patrimoine physique et financier (Kustos)',
  'Tu es l''agent Patrimoine. Tu réponds aux questions sur le patrimoine physique (montres, voitures de collection, immobilier) et financier (crypto, actions) suivi dans Kustos. Utilise SYSTÉMATIQUEMENT tes outils (get_actifs_patrimoine, get_alertes_ouvertes, get_portefeuille_financier, get_actif_detail) pour répondre avec des données réelles et à jour — ne réponds jamais de mémoire sur une valeur, une échéance ou une alerte. Cite les chiffres précis renvoyés par les outils. Tu es en lecture seule : si on te demande de créer, modifier ou supprimer quelque chose, dis-le clairement plutôt que de prétendre l''avoir fait. Réponds en français, de façon concise et factuelle.',
  '💎',
  '#B08D57',
  false
);

-- Rend l'agent routable depuis le Manager global (celui utilisé par défaut
-- par toute organisation sans Manager dédié — c'est le cas de l'org
-- "MAINTAIN — Admin" par exemple). Édition ciblée via replace() : si le
-- texte exact ne matche pas plus (prompt modifié entre-temps), c'est un
-- no-op silencieux — vérifier après coup que "Patrimoine" apparaît bien
-- dans le prompt du Manager (id ci-dessous).
update agents
set prompt = replace(
  prompt,
  'Agents disponibles : Maintenance, Sécurité / HSE, Qualité, Procédures RH.',
  'Agents disponibles : Maintenance, Sécurité / HSE, Qualité, Procédures RH, Patrimoine.'
)
where id = '57be6698-d16d-4c9c-90d2-e4fe26577de9';

-- Vérification : doit renvoyer le prompt du Manager avec "Patrimoine" dedans.
-- select prompt from agents where id = '57be6698-d16d-4c9c-90d2-e4fe26577de9';

-- NB : les Managers dédiés par organisation ("Manager Patrimoine" sur l'org
-- démo "Gestion Patrimoine", "Manager PME", "Manager Foot") ne sont PAS
-- mis à jour ici — ce sont des verticales de démo indépendantes, sans lien
-- avec le Kustos réel (coïncidence de nom pour la première). À adapter au
-- cas par cas si un jour Kustos doit être routable depuis ces org-là aussi.
