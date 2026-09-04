// Bridge serveur entre les agents WRZ Ops et les données Kustos (module
// patrimoine, projet séparé — voir kustos/docs/manager-integration.md pour
// le plan complet). Contrairement à AirWatch, Kustos vit dans le MÊME projet
// Supabase que WRZ Ops (schéma "kustos" plutôt qu'un projet séparé) : pas de
// deuxième clé service_role à gérer, juste cibler le bon schéma via le
// header PostgREST Accept-Profile.
//
// Décisions prises (voir manager-integration.md) :
//   - accès non filtré par organisation : Kustos est mono-utilisateur en V1,
//     aucune notion d'org côté données. Tout utilisateur WRZ Ops connecté
//     peut interroger ces tools (comme la boîte mail), pas de mapping du
//     genre organizations.airwatch_org_id à faire ici.
//   - lecture seule : aucun tool n'écrit dans kustos.*.

import { getUserFromToken, sbAdmin, isRateLimited } from './_lib/shared.js';

const KUSTOS_HEADERS = { headers: { 'Accept-Profile': 'kustos' } };

function effectiveValue(asset) {
  return asset.market_value ?? asset.estimated_value ?? null;
}

async function getActifsPatrimoine() {
  const assets = await sbAdmin(
    'assets?select=id,category,name,location,last_service_date,estimated_value,market_value,market_value_updated_at&order=name',
    KUSTOS_HEADERS
  );
  return assets.map(a => ({
    id: a.id,
    category: a.category,
    name: a.name,
    location: a.location,
    last_service_date: a.last_service_date,
    valeur_actuelle_eur: effectiveValue(a),
    source_valeur: a.market_value != null ? 'cote_marche_ia' : 'estimation_manuelle',
    cote_marche_maj_le: a.market_value_updated_at
  }));
}

async function getAlertesOuvertes() {
  return sbAdmin(
    "alerts?status=eq.open&select=id,title,reason,urgency_level,window_deadline,source,actif:assets(name,category,location)&order=urgency_level.asc,window_deadline.asc",
    KUSTOS_HEADERS
  );
}

async function getPortefeuilleFinancier() {
  const holdings = await sbAdmin(
    'financial_holdings?select=kind,name,symbol,quantity,manual_value,live_unit_price,live_price_updated_at,source&order=name',
    KUSTOS_HEADERS
  );
  return holdings.map(h => ({
    kind: h.kind,
    name: h.name,
    symbol: h.symbol,
    quantity: h.quantity,
    valeur_actuelle_eur: h.live_unit_price != null ? h.live_unit_price * h.quantity : h.manual_value,
    source: h.source,
    prix_maj_le: h.live_price_updated_at
  }));
}

async function getActifDetail(assetName) {
  if (!assetName) return { error: 'asset_name requis' };
  const assets = await sbAdmin(
    `assets?name=ilike.*${encodeURIComponent(assetName)}*&select=*&limit=1`,
    KUSTOS_HEADERS
  );
  const asset = assets?.[0];
  if (!asset) return { error: `Actif "${assetName}" introuvable` };

  const [documents, alerts] = await Promise.all([
    sbAdmin(`asset_documents?asset_id=eq.${asset.id}&select=file_name,extracted_intervals,uploaded_at&order=uploaded_at.desc`, KUSTOS_HEADERS),
    sbAdmin(`alerts?asset_id=eq.${asset.id}&select=title,reason,urgency_level,window_deadline,status,source&order=created_at.desc`, KUSTOS_HEADERS)
  ]);

  return {
    name: asset.name,
    category: asset.category,
    location: asset.location,
    last_service_date: asset.last_service_date,
    valeur_actuelle_eur: effectiveValue(asset),
    documents_techniques: documents,
    alertes: alerts
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (isRateLimited('kustos:' + user.id)) {
    return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
  }

  const { tool_name, input } = req.body || {};
  if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });

  try {
    let result;
    switch (tool_name) {
      case 'get_actifs_patrimoine':
        result = await getActifsPatrimoine();
        break;
      case 'get_alertes_ouvertes':
        result = await getAlertesOuvertes();
        break;
      case 'get_portefeuille_financier':
        result = await getPortefeuilleFinancier();
        break;
      case 'get_actif_detail':
        result = await getActifDetail(input?.asset_name);
        break;
      default:
        return res.status(400).json({ error: 'Tool inconnu: ' + tool_name });
    }
    res.status(200).json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
