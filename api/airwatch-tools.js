// Bridge serveur entre les agents WRZ Ops et la base AirWatch (projet Supabase
// séparé : gischstcsclscncmgkfd). Les tools de l'agent maintenance tournent
// côté navigateur mais n'ont jamais la clé service_role AirWatch — ils passent
// tous par cet endpoint, qui :
//   1. authentifie l'utilisateur WRZ Ops (comme les autres endpoints agent-*),
//   2. résout SON organisation WRZ Ops -> l'org_id AirWatch qui lui est mappé
//      (colonne organizations.airwatch_org_id, absente = pas d'accès),
//   3. interroge AirWatch avec la clé service_role, systématiquement filtré
//      par cet org_id (la vraie frontière de sécurité ici, les RLS d'AirWatch
//      n'entrant pas en jeu puisqu'on ne passe pas par une session AirWatch).

import { getUserFromToken, getProfile, sbAdmin, isRateLimited } from './_lib/shared.js';

const AIRWATCH_SUPABASE_URL = 'https://gischstcsclscncmgkfd.supabase.co';

async function awAdmin(path) {
  const res = await fetch(`${AIRWATCH_SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: process.env.AIRWATCH_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.AIRWATCH_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`AirWatch Supabase ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function resolveCompressorId(orgId, name) {
  const rows = await awAdmin(`compressors?org_id=eq.${orgId}&name=eq.${encodeURIComponent(name)}&select=id`);
  return rows?.[0]?.id || null;
}

function latestPerCompressor(measurements) {
  const map = new Map();
  for (const m of measurements) {
    if (!map.has(m.compressor_id)) map.set(m.compressor_id, m);
  }
  return map;
}

async function getCompresseursListe(orgId) {
  return awAdmin(`compressors?org_id=eq.${orgId}&select=id,name,marque,type,puissance,debit,pression,annee_installation,zones(name)&order=name`);
}

async function getDernierReleve(orgId, compressorName) {
  if (!compressorName) return { error: 'compressor_name requis' };
  const compressorId = await resolveCompressorId(orgId, compressorName);
  if (!compressorId) return { error: `Compresseur "${compressorName}" introuvable` };
  const rows = await awAdmin(`measurements?org_id=eq.${orgId}&compressor_id=eq.${compressorId}&select=*&order=measured_at.desc&limit=1`);
  return rows?.[0] || { message: 'Aucun relevé enregistré pour ce compresseur.' };
}

async function getCompresseursARisque(orgId) {
  const today = new Date().toISOString().slice(0, 10);
  const all = await awAdmin(`measurements?org_id=eq.${orgId}&select=*,compressors(name)&order=measured_at.desc`);
  const latest = latestPerCompressor(all);
  return [...latest.values()].filter(m =>
    m.maintenance_request || (m.next_maintenance_date && m.next_maintenance_date <= today)
  );
}

async function getHistoriqueReleves(orgId, compressorName, limit) {
  if (!compressorName) return { error: 'compressor_name requis' };
  const compressorId = await resolveCompressorId(orgId, compressorName);
  if (!compressorId) return { error: `Compresseur "${compressorName}" introuvable` };
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
  return awAdmin(`measurements?org_id=eq.${orgId}&compressor_id=eq.${compressorId}&select=*&order=measured_at.desc&limit=${safeLimit}`);
}

async function getRecentAnomalies(orgId) {
  return awAdmin(`anomalies?org_id=eq.${orgId}&resolved=eq.false&select=*,compressors(name)&order=detected_at.desc&limit=20`);
}

async function getZoneSummary(orgId, zoneInput) {
  if (!zoneInput) return { error: 'zone requis' };
  const zones = await awAdmin(`zones?org_id=eq.${orgId}&select=id,name,short_code`);
  const needle = zoneInput.toLowerCase();
  const zone = zones.find(z =>
    z.name.toLowerCase() === needle ||
    z.short_code?.toLowerCase() === needle ||
    z.name.toLowerCase().endsWith(needle)
  );
  if (!zone) return { error: `Zone "${zoneInput}" introuvable`, zones_disponibles: zones.map(z => z.name) };

  const compressors = await awAdmin(`compressors?org_id=eq.${orgId}&zone_id=eq.${zone.id}&select=id,name,marque,type&order=name`);
  if (!compressors.length) return { zone: zone.name, compressors: [] };

  const ids = compressors.map(c => c.id).join(',');
  const measurements = await awAdmin(`measurements?org_id=eq.${orgId}&compressor_id=in.(${ids})&select=*&order=measured_at.desc`);
  const latest = latestPerCompressor(measurements);

  return {
    zone: zone.name,
    compressors: compressors.map(c => {
      const m = latest.get(c.id);
      return {
        name: c.name,
        marque: c.marque,
        type: c.type,
        etat: m?.etat_compresseur || 'Non renseigné',
        hour_counter: m?.hour_counter ?? null,
        maintenance_request: m?.maintenance_request || null,
        next_maintenance_date: m?.next_maintenance_date || null,
        last_measured_at: m?.measured_at || null
      };
    })
  };
}

async function createMaintenanceRequest(orgId, compressorName, priority, motif) {
  if (!compressorName) return { error: 'compressor_name requis' };
  if (!motif) return { error: 'motif requis' };
  const compressorId = await resolveCompressorId(orgId, compressorName);
  if (!compressorId) return { error: `Compresseur "${compressorName}" introuvable` };
  const safePriority = priority === 'urgente' ? 'urgente' : 'normale';

  const res = await fetch(`${AIRWATCH_SUPABASE_URL}/rest/v1/maintenance_requests`, {
    method: 'POST',
    headers: {
      apikey: process.env.AIRWATCH_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.AIRWATCH_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: JSON.stringify({
      org_id: orgId, compressor_id: compressorId, priority: safePriority,
      motif, status: 'ouverte', created_by: 'Agent Maintenance (WRZ Ops)'
    })
  });
  if (!res.ok) throw new Error(`Création demande échouée : ${res.status} ${await res.text()}`);
  const [created] = await res.json();
  return { success: true, id: created.id, compressor: compressorName, priority: safePriority, motif, status: 'ouverte' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const user = await getUserFromToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  if (isRateLimited('airwatch:' + user.id)) {
    return res.status(429).json({ error: 'Trop de requêtes, réessaie dans une minute.' });
  }

  const profile = await getProfile(user.id);
  if (!profile) return res.status(401).json({ error: 'Unauthorized' });

  const [org] = await sbAdmin(`organizations?id=eq.${profile.org_id}&select=airwatch_org_id`);
  const airwatchOrgId = org?.airwatch_org_id;
  if (!airwatchOrgId) {
    return res.status(403).json({ error: "Cette organisation n'a pas accès aux données AirWatch." });
  }

  const { tool_name, input } = req.body || {};
  if (!tool_name) return res.status(400).json({ error: 'tool_name is required' });

  try {
    let result;
    switch (tool_name) {
      case 'get_compresseurs_liste':
        result = await getCompresseursListe(airwatchOrgId);
        break;
      case 'get_dernier_releve':
        result = await getDernierReleve(airwatchOrgId, input?.compressor_name);
        break;
      case 'get_compresseurs_a_risque':
        result = await getCompresseursARisque(airwatchOrgId);
        break;
      case 'get_historique_releves':
        result = await getHistoriqueReleves(airwatchOrgId, input?.compressor_name, input?.limit);
        break;
      case 'get_recent_anomalies':
        result = await getRecentAnomalies(airwatchOrgId);
        break;
      case 'get_zone_summary':
        result = await getZoneSummary(airwatchOrgId, input?.zone);
        break;
      case 'create_maintenance_request':
        result = await createMaintenanceRequest(airwatchOrgId, input?.compressor_name, input?.priority, input?.motif);
        break;
      default:
        return res.status(400).json({ error: 'Tool inconnu: ' + tool_name });
    }
    res.status(200).json({ result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
