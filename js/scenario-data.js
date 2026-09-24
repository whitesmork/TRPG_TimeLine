import { state } from './state.js';

export function getScenarioById(id) {
  return state.scenarios.find((scenario) => scenario.id === id);
}

export function getMonthKey(scenario) {
  return `${scenario.year}-${scenario.month}`;
}

export function getMonthLabel(year, month) {
  return `${year}年目 ${month}月`;
}

export function getParticipants(scenario) {
  return [...(scenario.pcs || []), ...(scenario.npcs || [])].filter(Boolean);
}

export function getSharedParticipants(a, b) {
  const setA = new Set(getParticipants(a));
  const setB = new Set(getParticipants(b));
  return [...setA].filter((value) => setB.has(value));
}

export function hasSameParticipantName(a, b) {
  return getSharedParticipants(a, b).length > 0;
}

export function getScenarioDateValue(scenario) {
  return scenario.year * 12 + scenario.month;
}

export function parseParticipants(value) {
  return [...new Set(
    (value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  )];
}

export function normalizeScenario(rawScenario, index = 0) {
  const id = rawScenario?.id || `s${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const year = Number(rawScenario?.year) || 1;
  const month = Number(rawScenario?.month) || 1;
  const xPriority = Number.isFinite(Number(rawScenario?.xPriority)) ? Number(rawScenario.xPriority) : 1;
  const title = rawScenario?.title || `シナリオ${index + 1}`;
  const information = rawScenario?.information && typeof rawScenario.information === 'object' ? rawScenario.information : {};
  const referenceId = rawScenario?.placement?.referenceScenarioId
    ? String(rawScenario.placement.referenceScenarioId)
    : null;
  const placement = referenceId && referenceId !== id
    ? {
        referenceScenarioId: referenceId,
        relation: rawScenario.placement.relation === 'after' ? 'after' : 'same'
      }
    : null;

  const tags = Array.isArray(rawScenario?.tags)
    ? rawScenario.tags
        .filter(Boolean)
        .map((tag) => (typeof tag === 'string' ? tag : tag?.id || ''))
        .filter(Boolean)
    : [];

  return {
    id,
    year,
    month,
    xPriority,
    title,
    summary: rawScenario?.summary ?? '',
    stage: typeof rawScenario?.stage === 'string' ? rawScenario.stage : '',
    information: {
      trailer: typeof information.trailer === 'string' ? information.trailer : 'なし',
      description: typeof information.description === 'string' ? information.description : '詳細なし'
    },
    gm: typeof rawScenario?.gm === 'string' ? rawScenario.gm : '',
    pcs: Array.isArray(rawScenario?.pcs) ? rawScenario.pcs.filter(Boolean) : [],
    npcs: Array.isArray(rawScenario?.npcs) ? rawScenario.npcs.filter(Boolean) : [],
    tags,
    placement
  };
}

export function normalizeScenarios(rawScenarios) {
  if (!Array.isArray(rawScenarios)) return [];
  return rawScenarios.map((scenario, index) => normalizeScenario(scenario, index));
}

export function parseTagNames(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

export function getTagIdsFromNames(tagNames) {
  return parseTagNames(tagNames)
    .map((tagName) => state.tags.find((tag) => tag.name === tagName)?.id)
    .filter(Boolean);
}

export function getTagById(tagId) {
  return state.tags.find((tag) => tag.id === tagId) || null;
}

export function getScenarioTags(scenario) {
  if (!scenario || !Array.isArray(scenario.tags)) return [];
  return scenario.tags.map(getTagById).filter(Boolean);
}

export function getScenarioTagGradient(scenario) {
  const tags = getScenarioTags(scenario);
  return tags.length ? `linear-gradient(90deg, ${tags.map((tag) => tag.color).join(', ')})` : '';
}

export function normalizeTag(rawTag, index = 0) {
  const name = String(rawTag?.name || '').trim() || `タグ${index + 1}`;
  const color = typeof rawTag?.color === 'string' && rawTag.color ? rawTag.color : '#5b8cff';
  const id = rawTag?.id || `tag-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
  return { id, name, color };
}
