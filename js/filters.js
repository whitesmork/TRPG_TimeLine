import {
  state,
  filterKeywordEl,
  filterTitleEl,
  filterSummaryEl,
  filterGmEl,
  filterCharacterEl,
  filterTagNamesEl,
  filterTagChipsEl,
  filterStageNamesEl,
  filterStageChipsEl,
  filterTagModeEl,
  filterYearFromEl,
  filterYearToEl,
  filterMonthFromEl,
  filterMonthToEl,
  filterDetailToggleBtn,
  filterAdvancedPanelEl,
  filterResetBtn,
  filterStatusEl
} from './state.js';
import { parseTagNames } from './scenario-data.js';

function normalizeNumber(value, min, max) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  if (Number.isNaN(number)) return null;
  return Math.max(min, Math.min(max, number));
}

function readValues() {
  const tagNames = parseTagNames(filterTagNamesEl?.value || '');
  return {
    keyword: (filterKeywordEl?.value || '').trim().toLowerCase(),
    title: (filterTitleEl?.value || '').trim().toLowerCase(),
    summary: (filterSummaryEl?.value || '').trim().toLowerCase(),
    gm: (filterGmEl?.value || '').trim().toLowerCase(),
    character: (filterCharacterEl?.value || '').trim().toLowerCase(),
    tagIds: tagNames.map((name) => state.tags.find((tag) => tag.name === name)?.id || `missing:${name}`),
    stage: (filterStageNamesEl?.value || '').trim().toLowerCase(),
    stageNames: parseTagNames(filterStageNamesEl?.value || ''),
    tagMode: filterTagModeEl?.value === 'and' ? 'and' : 'or',
    yearFrom: normalizeNumber(filterYearFromEl?.value, 1, 99),
    yearTo: normalizeNumber(filterYearToEl?.value, 1, 99),
    monthFrom: normalizeNumber(filterMonthFromEl?.value, 1, 12),
    monthTo: normalizeNumber(filterMonthToEl?.value, 1, 12)
  };
}

function matchesText(value, query) {
  return !query || String(value || '').toLowerCase().includes(query);
}

function matchesScenario(scenario, values) {
  const characters = [...(scenario.pcs || []), ...(scenario.npcs || [])].join(' ').toLowerCase();
  const tags = new Set(Array.isArray(scenario.tags) ? scenario.tags : []);
  const stageMatches = !values.stageNames.length || values.stageNames.some((name) => scenario.stage.toLowerCase().includes(name.toLowerCase()));
  const tagMatches = !values.tagIds.length || (values.tagMode === 'and'
    ? values.tagIds.every((id) => tags.has(id))
    : values.tagIds.some((id) => tags.has(id)));
  const keywordTarget = [scenario.title, scenario.summary, scenario.stage, scenario.gm, ...scenario.pcs, ...scenario.npcs]
    .filter(Boolean).join(' ').toLowerCase();
  const dateMatches = (values.yearFrom === null || scenario.year >= values.yearFrom)
    && (values.yearTo === null || scenario.year <= values.yearTo)
    && (values.monthFrom === null || scenario.month >= values.monthFrom)
    && (values.monthTo === null || scenario.month <= values.monthTo);

  return dateMatches
    && matchesText(scenario.title, values.title)
    && matchesText(scenario.summary, values.summary)
    && matchesText(scenario.gm, values.gm)
    && matchesText(scenario.stage, values.stage)
    && (!values.character || characters.includes(values.character))
    && tagMatches
    && stageMatches
    && (!values.keyword || keywordTarget.includes(values.keyword));
}

export function updateSearchState() {
  const values = readValues();
  state.search = {
    ...state.search,
    ...values,
    active: Boolean(values.keyword || values.title || values.summary || values.gm || values.character
      || values.tagIds.length || values.stageNames.length || values.yearFrom !== null
      || values.yearTo !== null || values.monthFrom !== null || values.monthTo !== null),
    resultIds: state.scenarios.filter((scenario) => matchesScenario(scenario, values)).map((scenario) => scenario.id)
  };
}

function renderTagOptions(apply) {
  if (!filterTagChipsEl || !filterTagNamesEl) return;
  const selected = new Set(parseTagNames(filterTagNamesEl.value));
  filterTagChipsEl.innerHTML = state.tags.map((tag) => `<button type="button" class="tag-chip ${selected.has(tag.name) ? 'selected' : ''}" data-tag-name="${tag.name}" style="--chip-color:${tag.color};">${tag.name}</button>`).join('');
  filterTagChipsEl.querySelectorAll('.tag-chip').forEach((button) => button.addEventListener('click', () => {
    const names = parseTagNames(filterTagNamesEl.value);
    const name = button.dataset.tagName;
    filterTagNamesEl.value = (names.includes(name) ? names.filter((item) => item !== name) : [...names, name]).join(', ');
    renderTagOptions(apply);
    apply();
  }));
}

function renderStageOptions(apply) {
  if (!filterStageChipsEl || !filterStageNamesEl) return;
  const selected = new Set(parseTagNames(filterStageNamesEl.value));
  const stages = [...new Set(state.scenarios.map((scenario) => String(scenario.stage || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  filterStageChipsEl.innerHTML = stages.map((stage) => `<button type="button" class="tag-chip ${selected.has(stage) ? 'selected' : ''}" data-stage-name="${stage}" style="--chip-color:#5b8cff;">${stage}</button>`).join('');
  filterStageChipsEl.querySelectorAll('.tag-chip').forEach((button) => button.addEventListener('click', () => {
    const names = parseTagNames(filterStageNamesEl.value);
    const name = button.dataset.stageName;
    filterStageNamesEl.value = (names.includes(name) ? names.filter((item) => item !== name) : [...names, name]).join(', ');
    renderStageOptions(apply);
    apply();
  }));
}

export function refreshFilterOptions(apply) {
  renderTagOptions(apply);
  renderStageOptions(apply);
}

function reset(apply) {
  [filterKeywordEl, filterTitleEl, filterSummaryEl, filterGmEl, filterCharacterEl, filterTagNamesEl, filterStageNamesEl, filterYearFromEl, filterYearToEl, filterMonthFromEl, filterMonthToEl].forEach((input) => {
    if (input) input.value = '';
  });
  if (filterTagModeEl) filterTagModeEl.value = 'or';
  refreshFilterOptions(apply);
  apply();
}

export function initializeFilters(apply) {
  refreshFilterOptions(apply);
  [filterKeywordEl, filterTitleEl, filterSummaryEl, filterGmEl, filterCharacterEl, filterTagNamesEl, filterStageNamesEl, filterTagModeEl, filterYearFromEl, filterYearToEl, filterMonthFromEl, filterMonthToEl]
    .filter(Boolean)
    .forEach((input) => {
      input.addEventListener('input', apply);
      input.addEventListener('change', apply);
    });
  filterResetBtn?.addEventListener('click', () => reset(apply));
  filterDetailToggleBtn?.addEventListener('click', () => {
    const hidden = filterAdvancedPanelEl.classList.toggle('hidden');
    filterDetailToggleBtn.setAttribute('aria-expanded', String(!hidden));
    filterDetailToggleBtn.textContent = hidden ? '詳細' : '詳細を閉じる';
  });
}

export function updateFilterStatus(getVisibleScenarios) {
  if (!filterStatusEl) return;
  const total = state.scenarios.length;
  const visible = getVisibleScenarios().length;
  filterStatusEl.textContent = state.search.active ? `検索中 ${visible}/${total}件` : `全件表示 ${total}件`;
  filterStatusEl.classList.toggle('active', state.search.active);
}
