export const state = {
  scenarios: [],
  tags: [],
  selectedScenarioId: null,
  search: {
    keyword: '',
    title: '',
    summary: '',
    gm: '',
    character: '',
    tagIds: [],
    stageNames: [],
    stage: '',
    tagMode: 'or',
    yearFrom: '',
    yearTo: '',
    monthFrom: '',
    monthTo: '',
    active: false,
    resultIds: []
  }
};

export const timelineEl = document.getElementById('timeline');
export const scenarioListEl = document.getElementById('scenario-list');
export const detailPanelEl = document.getElementById('detail-panel');
export const filterKeywordEl = document.getElementById('filter-keyword');
export const filterTitleEl = document.getElementById('filter-title');
export const filterSummaryEl = document.getElementById('filter-summary');
export const filterGmEl = document.getElementById('filter-gm');
export const filterCharacterEl = document.getElementById('filter-character');
export const filterTagNamesEl = document.getElementById('filter-tag-names');
export const filterTagChipsEl = document.getElementById('filter-tag-chips');
export const filterStageNamesEl = document.getElementById('filter-stage-names');
export const filterStageChipsEl = document.getElementById('filter-stage-chips');
export const filterTagModeEl = document.getElementById('filter-tag-mode');
export const filterYearFromEl = document.getElementById('filter-year-from');
export const filterYearToEl = document.getElementById('filter-year-to');
export const filterMonthFromEl = document.getElementById('filter-month-from');
export const filterMonthToEl = document.getElementById('filter-month-to');
export const filterDetailToggleBtn = document.getElementById('filter-detail-toggle-btn');
export const filterAdvancedPanelEl = document.getElementById('filter-advanced-panel');
export const filterResetBtn = document.getElementById('filter-reset-btn');
export const filterStatusEl = document.getElementById('filter-status');

export const timelineZoomState = {
  scale: 1,
  min: 0.7,
  max: 1.8
};
