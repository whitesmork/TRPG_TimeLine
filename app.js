import {
  state,
  timelineEl,
  scenarioListEl,
  detailPanelEl,
  timelineZoomState
} from './js/state.js';
import {
  getScenarioById,
  getMonthKey,
  getMonthLabel,
  getParticipants,
  getSharedParticipants,
  hasSameParticipantName,
  getScenarioDateValue,
  parseParticipants,
  normalizeScenarios,
  parseTagNames,
  getTagIdsFromNames,
  getTagById,
  getScenarioTags,
  getScenarioTagGradient,
  normalizeTag
} from './js/scenario-data.js';
import {
  initializeFilters,
  refreshFilterOptions,
  updateSearchState as updateSearchStateFromFilters,
  updateFilterStatus
} from './js/filters.js';
import { groupScenariosByMonth, sortMonthKeys } from './js/timeline-layout.js';
import { getScenarioPairKey, getConnectionEndpoints, isSameRelation } from './js/connections.js';
import { getSelectedScenario } from './js/renderer.js';
import { getScenarioFormMode, getRelationValue } from './js/modals.js';
import { downloadFile, createJsonPayload } from './js/persistence.js';

function getVisibleScenarios() {
  if (!state.search.active) {
    return state.scenarios;
  }

  const idSet = new Set(state.search.resultIds);
  return state.scenarios.filter((scenario) => idSet.has(scenario.id));
}

function syncSelectedScenarioToVisible() {
  const visible = getVisibleScenarios();
  const visibleIds = new Set(visible.map((scenario) => scenario.id));

  if (!visible.length) {
    state.selectedScenarioId = null;
    return;
  }

  if (!visibleIds.has(state.selectedScenarioId)) {
    state.selectedScenarioId = visible[0].id;
  }
}

function applyFiltersAndRender() {
  syncSelectedScenarioToVisible();
  render();
}

function getLatestSharedParticipantPairIds(allScenarios) {
  const participantMap = new Map();

  allScenarios.forEach((scenario) => {
    const participants = [...new Set([...(scenario.pcs || []), ...(scenario.npcs || [])].filter(Boolean))];
    participants.forEach((participant) => {
      if (!participantMap.has(participant)) {
        participantMap.set(participant, []);
      }
      participantMap.get(participant).push(scenario);
    });
  });

  const pairIds = new Set();
  participantMap.forEach((scenariosForParticipant) => {
    const uniqueScenarios = [...new Map(
      scenariosForParticipant.map((scenario) => [scenario.id, scenario])
    ).values()].sort((a, b) => {
      const dateDiff = getScenarioDateValue(a) - getScenarioDateValue(b);
      return dateDiff || a.title.localeCompare(b.title);
    });

    for (let index = 1; index < uniqueScenarios.length; index += 1) {
      const previous = uniqueScenarios[index - 1];
      const current = uniqueScenarios[index];
      pairIds.add([previous.id, current.id].sort().join(':'));
    }
  });

  return pairIds;
}

function getSharedParticipantPairIdsByVisualOrder(positionedScenarios) {
  const participantMap = new Map();

  positionedScenarios.forEach((item) => {
    const participants = [...new Set(getParticipants(item.scenario))];
    participants.forEach((participant) => {
      if (!participantMap.has(participant)) {
        participantMap.set(participant, []);
      }
      participantMap.get(participant).push(item);
    });
  });

  const pairIds = new Set();
  participantMap.forEach((scenariosForParticipant) => {
    const uniqueScenarios = [...new Map(
      scenariosForParticipant.map((item) => [item.scenario.id, item])
    ).values()].sort((a, b) => {
      const yDiff = a.rect.cy - b.rect.cy;
      if (Math.abs(yDiff) > 0.01) return yDiff;

      const xDiff = a.rect.cx - b.rect.cx;
      if (Math.abs(xDiff) > 0.01) return xDiff;

      return a.scenario.title.localeCompare(b.scenario.title);
    });

    for (let index = 1; index < uniqueScenarios.length; index += 1) {
      const previous = uniqueScenarios[index - 1];
      const current = uniqueScenarios[index];
      pairIds.add([previous.scenario.id, current.scenario.id].sort().join(':'));
    }
  });

  return pairIds;
}

function getNearestEdgePoint(rect, groupRect, targetPoint, preferHorizontal = true) {
  const left = { x: rect.left - groupRect.left, y: rect.top - groupRect.top + rect.height / 2 };
  const right = { x: rect.left - groupRect.left + rect.width, y: rect.top - groupRect.top + rect.height / 2 };
  const top = { x: rect.left - groupRect.left + rect.width / 2, y: rect.top - groupRect.top };
  const bottom = { x: rect.left - groupRect.left + rect.width / 2, y: rect.top - groupRect.top + rect.height };

  const horizontalCandidates = [left, right];
  const verticalCandidates = [top, bottom];

  const candidateList = preferHorizontal ? [...horizontalCandidates, ...verticalCandidates] : [...verticalCandidates, ...horizontalCandidates];

  return candidateList.reduce((nearest, candidate) => {
    const nearestDistance = Math.hypot(nearest.x - targetPoint.x, nearest.y - targetPoint.y);
    const candidateDistance = Math.hypot(candidate.x - targetPoint.x, candidate.y - targetPoint.y);
    return candidateDistance < nearestDistance ? candidate : nearest;
  }, candidateList[0]);
}

function refreshTagSelectOptions() {
  const modal = document.getElementById('scenario-form-modal');
  if (!modal) return;
  const tagInput = modal.querySelector('input[name="tagNames"]');
  if (!tagInput) return;
  const currentValue = tagInput.value;
  const selectedTags = currentValue
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const tagNames = state.tags.map((tag) => tag.name);
  const available = tagNames.filter((name) => !selectedTags.includes(name));
  tagInput.dataset.availableTags = JSON.stringify(available);
}

function buildReferenceOptions(currentScenarioId = null) {
  const candidates = state.scenarios.filter((scenario) => scenario.id !== currentScenarioId);
  return ['<option value="">なし</option>']
    .concat(candidates.map((scenario) => `<option value="${scenario.id}">${scenario.title}</option>`))
    .join('');
}

function buildTagOptions(selectedTagIds = []) {
  const selectedSet = new Set(selectedTagIds);
  return state.tags
    .map((tag) => `<option value="${tag.id}" ${selectedSet.has(tag.id) ? 'selected' : ''}>${tag.name}</option>`)
    .join('');
}

function renderTagChipSelection(chipsEl, tagInput) {
  if (!chipsEl || !tagInput) return;
  const selectedNames = parseTagNames(tagInput.value);
  const selectedSet = new Set(selectedNames);
  chipsEl.innerHTML = state.tags
    .map((tag) => {
      const isSelected = selectedSet.has(tag.name);
      return `<button type="button" class="tag-chip ${isSelected ? 'selected' : ''}" data-tag-name="${tag.name}" style="--chip-color:${tag.color};">${tag.name}</button>`;
    })
    .join('');

  chipsEl.querySelectorAll('.tag-chip').forEach((button) => {
    button.addEventListener('click', () => {
      const tagName = button.dataset.tagName;
      const currentNames = parseTagNames(tagInput.value);
      const nextNames = currentNames.includes(tagName)
        ? currentNames.filter((name) => name !== tagName)
        : [...currentNames, tagName];
      tagInput.value = nextNames.join(', ');
      renderTagChipSelection(chipsEl, tagInput);
    });
  });
}

function ensureScenarioModal() {
  let modal = document.getElementById('scenario-form-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'scenario-form-modal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-backdrop" data-close-modal="true"></div>
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="scenario-form-title">
      <div class="modal-header">
        <h3 id="scenario-form-title">シナリオ追加</h3>
        <button type="button" class="icon-btn" data-close-modal="true" aria-label="閉じる">×</button>
      </div>
      <form id="scenario-form" class="scenario-form">
        <div class="form-row two-col">
          <label>
            <span>タイトル</span>
            <input name="title" type="text" required placeholder="例: Crumble Days" />
          </label>
          <label>
            <span>サマリー</span>
            <input name="summary" type="text" placeholder="例: 1陣 / N市" />
          </label>
        </div>

        <div class="form-row two-col">
          <label>
            <span>年目</span>
            <input name="year" type="number" min="1" max="99" required placeholder="例: 1" />
          </label>
          <label>
            <span>月</span>
            <input name="month" type="number" min="1" max="12" required />
          </label>
        </div>

        <div class="form-row two-col">
          <label>
            <span>X優先度</span>
            <input name="xPriority" type="number" min="1" step="1" placeholder="例: 4" />
          </label>
          <label>
            <span> </span>
            <div></div>
          </label>
        </div>

        <div class="form-row two-col">
          <label>
            <span>GM</span>
            <input name="gm" type="text" placeholder="GM" />
          </label>
          <label>
            <span>舞台</span>
            <input name="stage" type="text" placeholder="例: N市" />
          </label>
        </div>

        <div class="form-row two-col">
          <label>
            <span>参加PC</span>
            <input name="pcs" type="text" placeholder="A, B, C" />
          </label>
          <label>
            <span>登場NPC</span>
            <input name="npcs" type="text" placeholder="NPC-X, NPC-Y" />
          </label>
        </div>

        <div class="form-row">
          <label>
            <span>タグ</span>
            <input name="tagNames" type="text" placeholder="例: N市, D市" />
          </label>
        </div>

        <div class="form-row">
          <div class="tag-field-block">
            <span>既存タグ</span>
            <div class="tag-chip-list" id="existing-tag-chips"></div>
          </div>
        </div>

        <div class="form-row tag-create-row">
          <div class="tag-creator">
            <label>
              <span>新規タグ名</span>
              <input name="newTagName" type="text" placeholder="例: キャンペーン" />
            </label>
            <label>
              <span>色</span>
              <input name="newTagColor" type="color" value="#5b8cff" />
            </label>
            <button type="button" id="add-tag-btn" class="secondary-btn">タグ追加</button>
          </div>
        </div>

        <div class="form-row two-col">
          <label>
            <span>関係</span>
            <select name="relation">
              <option value="none">なし</option>
              <option value="same">同時期</option>
              <option value="after">以降</option>
            </select>
          </label>
          <label>
            <span>参照シナリオ</span>
            <select name="referenceScenarioId">
              <option value="">なし</option>
            </select>
          </label>
        </div>

        <div class="form-row">
          <label>
            <span>トレーラー</span>
            <textarea name="trailer" rows="2" placeholder="トレーラー文章"></textarea>
          </label>
        </div>

        <div class="form-row">
          <label>
            <span>詳細</span>
            <textarea name="description" rows="4" placeholder="シナリオの詳細"></textarea>
          </label>
        </div>

        <div class="form-actions">
          <button type="button" id="scenario-delete-btn" class="secondary-btn danger-btn" style="display:none; margin-right:auto;">削除</button>
          <button type="button" class="secondary-btn" data-close-modal="true">キャンセル</button>
          <button type="submit" id="scenario-submit-btn" class="primary-btn">追加する</button>
        </div>
      </form>
    </div>
  `;

  const form = modal.querySelector('#scenario-form');
  const deleteBtn = modal.querySelector('#scenario-delete-btn');
  const addTagBtn = modal.querySelector('#add-tag-btn');
  const submitBtn = form.querySelector('#scenario-submit-btn');
  const tagInput = form.querySelector('input[name="tagNames"]');
  const chipsEl = modal.querySelector('#existing-tag-chips');
  const newTagNameInput = form.querySelector('input[name="newTagName"]');
  const newTagColorInput = form.querySelector('input[name="newTagColor"]');

  const saveScenarioForm = () => {
    const titleInput = form.querySelector('[name="title"]');
    const summaryInput = form.querySelector('[name="summary"]');
    const yearInput = form.querySelector('[name="year"]');
    const monthInput = form.querySelector('[name="month"]');
    const xPriorityInput = form.querySelector('[name="xPriority"]');
    const gmInput = form.querySelector('[name="gm"]');
    const stageInput = form.querySelector('[name="stage"]');
    const pcsInput = form.querySelector('[name="pcs"]');
    const npcsInput = form.querySelector('[name="npcs"]');
    const trailerInput = form.querySelector('[name="trailer"]');
    const descriptionInput = form.querySelector('[name="description"]');
    const relationSelect = form.querySelector('[name="relation"]');
    const referenceSelect = form.querySelector('[name="referenceScenarioId"]');
    const tagInputField = form.querySelector('[name="tagNames"]');

    const title = titleInput?.value.trim() || '';
    const year = Number.parseInt(yearInput?.value || '', 10);
    const month = Number.parseInt(monthInput?.value || '', 10);
    const xPriority = Number.parseInt(xPriorityInput?.value || '', 10);
    const relation = relationSelect?.value || 'none';
    const referenceScenarioId = referenceSelect?.value || '';
    const selectedTagNames = parseTagNames(tagInputField?.value || '');
    const selectedTagIds = getTagIdsFromNames(selectedTagNames);

    if (!title) {
      alert('タイトルを入力してください。');
      return;
    }

    if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
      alert('年と月を正しく入力してください。');
      return;
    }

    if ((relation === 'same' || relation === 'after') && !referenceScenarioId) {
      alert('関係を持つ場合は参照シナリオを選択してください。');
      return;
    }

    const existingId = form.dataset.scenarioId || '';
    if (existingId && referenceScenarioId && referenceScenarioId === existingId) {
      alert('自分自身を参照シナリオにすることはできません。');
      return;
    }

    const scenario = {
      id: existingId || `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      year,
      month,
      xPriority: Number.isNaN(xPriority) ? 1 : Math.max(1, xPriority),
      title,
      summary: summaryInput?.value.trim() || '',
      stage: stageInput?.value.trim() || '',
      information: {
        trailer: trailerInput?.value.trim() || 'なし',
        description: descriptionInput?.value.trim() || '詳細なし'
      },
      gm: gmInput?.value.trim() || '',
      pcs: parseParticipants(pcsInput?.value || ''),
      npcs: parseParticipants(npcsInput?.value || ''),
      tags: selectedTagIds,
      placement: relation && referenceScenarioId && relation !== 'none'
        ? { referenceScenarioId, relation }
        : null
    };

    if (existingId) {
      const index = state.scenarios.findIndex((item) => item.id === existingId);
      if (index >= 0) {
        state.scenarios[index] = scenario;
      }
    } else {
      state.scenarios.push(scenario);
    }

    state.selectedScenarioId = scenario.id;
    form.reset();
    delete form.dataset.scenarioId;
    delete form.dataset.mode;
    closeScenarioModal();
    render();
  };

  if (!submitBtn) {
    return modal;
  }

  submitBtn.disabled = false;
  submitBtn.type = 'submit';
  submitBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();
    saveScenarioForm();
  };

  form.onsubmit = (event) => {
    event.preventDefault();
    saveScenarioForm();
    return false;
  };

  tagInput.addEventListener('input', () => {
    renderTagChipSelection(chipsEl, tagInput);
  });

  addTagBtn.addEventListener('click', () => {
    const newTagName = newTagNameInput?.value.trim() || '';
    const newTagColor = newTagColorInput?.value || '#5b8cff';
    if (!newTagName) {
      alert('新規タグ名を入力してください。');
      return;
    }

    const existingTag = state.tags.find((tag) => tag.name === newTagName);
    if (existingTag) {
      if (newTagNameInput) newTagNameInput.value = '';
      if (newTagColorInput) newTagColorInput.value = '#5b8cff';
      const currentNames = parseTagNames(tagInput.value);
      if (!currentNames.includes(existingTag.name)) {
        tagInput.value = [...currentNames, existingTag.name].join(', ');
      }
      renderTagChipSelection(chipsEl, tagInput);
      return;
    }

    const createdTag = normalizeTag({ name: newTagName, color: newTagColor }, state.tags.length);
    state.tags.push(createdTag);
    const currentNames = parseTagNames(tagInput.value);
    tagInput.value = [...currentNames, createdTag.name].join(', ');
    if (newTagNameInput) newTagNameInput.value = '';
    if (newTagColorInput) newTagColorInput.value = '#5b8cff';
    renderTagChipSelection(chipsEl, tagInput);
  });

  deleteBtn.addEventListener('click', () => {
    const scenarioId = form.dataset.scenarioId;
    if (!scenarioId) return;
    deleteScenario(scenarioId);
  });

  modal.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-close-modal="true"]');
    if (closeTarget) {
      closeScenarioModal();
    }
  });

  document.body.appendChild(modal);
  return modal;
}

function openScenarioModal(scenarioId = null) {
  const modal = ensureScenarioModal();
  const referenceSelect = modal.querySelector('select[name="referenceScenarioId"]');
  const form = modal.querySelector('#scenario-form');
  const titleEl = modal.querySelector('#scenario-form-title');
  const submitBtn = form.querySelector('#scenario-submit-btn');
  const deleteBtn = modal.querySelector('#scenario-delete-btn');
  const tagInput = form.querySelector('input[name="tagNames"]');
  const chipsEl = modal.querySelector('#existing-tag-chips');
  const scenario = scenarioId ? getScenarioById(scenarioId) : null;

  form.dataset.mode = getScenarioFormMode(scenario);
  deleteBtn.style.display = scenario ? 'inline-flex' : 'none';
  form.dataset.scenarioId = scenario ? scenario.id : '';
  titleEl.textContent = scenario ? 'シナリオ編集' : 'シナリオ追加';
  submitBtn.textContent = scenario ? '保存する' : '追加する';
  tagInput.value = scenario ? getScenarioTags(scenario).map((tag) => tag.name).join(', ') : '';
  renderTagChipSelection(chipsEl, tagInput);

  if (scenario) {
    form.querySelector('[name="title"]').value = scenario.title;
    form.querySelector('[name="summary"]').value = scenario.summary || '';
    form.querySelector('[name="year"]').value = scenario.year;
    form.querySelector('[name="month"]').value = scenario.month;
    form.querySelector('[name="xPriority"]').value = scenario.xPriority ?? 1;
    form.querySelector('[name="gm"]').value = scenario.gm || '';
    form.querySelector('[name="stage"]').value = scenario.stage || '';
    form.querySelector('[name="pcs"]').value = scenario.pcs.join(', ');
    form.querySelector('[name="npcs"]').value = scenario.npcs.join(', ');
    form.querySelector('[name="trailer"]').value = scenario.information?.trailer || '';
    form.querySelector('[name="description"]').value = scenario.information?.description || '';
    form.querySelector('[name="relation"]').value = getRelationValue(scenario.placement);
  } else {
    form.reset();
    form.querySelector('[name="year"]').value = 1;
    form.querySelector('[name="month"]').value = 1;
    form.querySelector('[name="xPriority"]').value = 1;
    form.querySelector('[name="stage"]').value = '';
    form.querySelector('[name="relation"]').value = 'none';
    form.querySelector('[name="newTagName"]').value = '';
    form.querySelector('[name="newTagColor"]').value = '#5b8cff';
  }

  form.querySelector('[name="referenceScenarioId"]').value = '';
  referenceSelect.innerHTML = buildReferenceOptions(scenario ? scenario.id : null);
  const currentReference = scenario?.placement?.referenceScenarioId || '';
  const isValidReference = currentReference && state.scenarios.some((item) => item.id === currentReference && item.id !== scenario?.id);
  form.querySelector('[name="referenceScenarioId"]').value = isValidReference ? currentReference : '';

  if (!scenario && referenceSelect.value === '') {
    form.querySelector('[name="relation"]').value = 'none';
  }

  modal.classList.remove('hidden');
}

function closeScenarioModal() {
  const modal = document.getElementById('scenario-form-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function syncTagsAfterBulkEdit() {
  state.scenarios = state.scenarios.map((scenario) => ({
    ...scenario,
    tags: Array.isArray(scenario.tags)
      ? scenario.tags.filter((tagId) => state.tags.some((tag) => tag.id === tagId))
      : []
  }));
}

function ensureTagManagerModal() {
  let modal = document.getElementById('tag-manager-modal');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'tag-manager-modal';
  modal.className = 'modal hidden';
  modal.innerHTML = `
    <div class="modal-backdrop" data-close-tag-manager="true"></div>
    <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-manager-title">
      <div class="modal-header">
        <h3 id="tag-manager-title">タグ管理</h3>
        <button type="button" class="icon-btn" data-close-tag-manager="true" aria-label="閉じる">×</button>
      </div>
      <div id="tag-manager-list" class="tag-manager-list"></div>
      <div class="tag-manager-actions">
        <button type="button" id="tag-manager-add-row-btn" class="secondary-btn">タグ追加</button>
        <button type="button" class="secondary-btn" data-close-tag-manager="true">閉じる</button>
        <button type="button" id="tag-manager-save-btn" class="primary-btn">保存</button>
      </div>
    </div>
  `;

  const listEl = modal.querySelector('#tag-manager-list');

  const renderTagManagerList = () => {
    listEl.innerHTML = state.tags.map((tag, index) => `
      <div class="tag-manager-row" draggable="true" data-tag-index="${index}" data-tag-id="${tag.id}">
        <input type="text" class="tag-manager-name" value="${tag.name.replace(/"/g, '&quot;')}" aria-label="タグ名" />
        <input type="color" class="tag-manager-color" value="${tag.color}" aria-label="タグ色" />
        <button type="button" class="secondary-btn danger-btn tag-manager-remove" data-tag-index="${index}">削除</button>
      </div>
    `).join('');

    const rows = [...listEl.querySelectorAll('.tag-manager-row')];
    rows.forEach((row) => {
      row.addEventListener('dragstart', () => {
        row.classList.add('dragging');
        row.dataset.draggingIndex = String(row.dataset.tagIndex);
      });

      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        delete row.dataset.draggingIndex;
      });

      row.addEventListener('dragover', (event) => {
        event.preventDefault();
      });

      row.addEventListener('drop', (event) => {
        event.preventDefault();
        const fromIndex = Number(row.dataset.draggingIndex ?? row.dataset.tagIndex);
        const toIndex = Number(row.dataset.tagIndex);
        if (Number.isNaN(fromIndex) || Number.isNaN(toIndex) || fromIndex === toIndex) return;

        const [movedTag] = state.tags.splice(fromIndex, 1);
        state.tags.splice(toIndex, 0, movedTag);
        renderTagManagerList();
      });
    });

    listEl.querySelectorAll('.tag-manager-remove').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.tagIndex);
        if (Number.isNaN(index)) return;
        state.tags.splice(index, 1);
        renderTagManagerList();
      });
    });
  };

  modal.querySelector('#tag-manager-add-row-btn').addEventListener('click', () => {
    state.tags.push({
      id: `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: '新規タグ',
      color: '#5b8cff'
    });
    renderTagManagerList();
  });

  const tagManagerSaveBtn = modal.querySelector('#tag-manager-save-btn');
  tagManagerSaveBtn.disabled = false;
  tagManagerSaveBtn.onclick = (event) => {
    event.preventDefault();
    event.stopPropagation();

    const rows = [...listEl.querySelectorAll('.tag-manager-row')];
    const nextTags = rows
      .map((row) => {
        const name = row.querySelector('.tag-manager-name').value.trim();
        const color = row.querySelector('.tag-manager-color').value || '#5b8cff';
        const id = row.dataset.tagId || `tag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return { id, name, color };
      })
      .filter((tag) => tag.name);

    const names = nextTags.map((tag) => tag.name);
    const hasDuplicate = names.some((name, index) => names.indexOf(name) !== index);
    if (hasDuplicate) {
      alert('タグ名が重複しています。名前を変えてください。');
      return;
    }

    state.tags = nextTags;
    syncTagsAfterBulkEdit();
    refreshTagSelectOptions();
    closeTagManagerModal();
    render();
  };

  modal.addEventListener('click', (event) => {
    const closeTarget = event.target.closest('[data-close-tag-manager="true"]');
    if (closeTarget) {
      closeTagManagerModal();
    }
  });

  document.body.appendChild(modal);
  renderTagManagerList();
  return modal;
}

function openTagManagerModal() {
  const modal = ensureTagManagerModal();
  modal.classList.remove('hidden');
}

function closeTagManagerModal() {
  const modal = document.getElementById('tag-manager-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

function computeMonthLayout(monthScenarios, placementState = null) {
  const scenarioMap = new Map(monthScenarios.map((s) => [s.id, s]));
  const depthMap = new Map();
  const sameGroupMap = new Map();

  const getScenarioPriority = (scenario) => Number.isFinite(Number(scenario?.xPriority)) ? Number(scenario.xPriority) : 9999;

  const compareLowPriorityFirst = (a, b) => {
    const diff = getScenarioPriority(b) - getScenarioPriority(a);
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title);
  };

  const compareWithinSameGroup = (a, b) => {
    const diff = getScenarioPriority(a) - getScenarioPriority(b);
    if (diff !== 0) return diff;
    return a.title.localeCompare(b.title);
  };

  const compareVisualTie = (a, b) => compareLowPriorityFirst(a, b);

  function resolveDepth(scenarioId, seen = new Set()) {
    if (seen.has(scenarioId)) {
      return 0;
    }

    if (depthMap.has(scenarioId)) {
      return depthMap.get(scenarioId);
    }

    seen.add(scenarioId);
    const scenario = scenarioMap.get(scenarioId);
    if (!scenario || !scenario.placement) {
      depthMap.set(scenarioId, 0);
      return 0;
    }

    const ref = scenarioMap.get(scenario.placement.referenceScenarioId);
    if (!ref) {
      depthMap.set(scenarioId, 0);
      return 0;
    }

    const baseDepth = resolveDepth(ref.id, seen);
    const nextDepth = scenario.placement.relation === 'same' ? baseDepth : baseDepth + 1;
    depthMap.set(scenarioId, nextDepth);
    return nextDepth;
  }

  monthScenarios.forEach((scenario) => {
    const ref = scenario.placement && scenarioMap.get(scenario.placement.referenceScenarioId);
    if (scenario.placement && scenario.placement.relation === 'same' && ref) {
      const refGroup = sameGroupMap.get(ref.id) ?? new Set([ref.id]);
      refGroup.add(scenario.id);
      sameGroupMap.set(ref.id, refGroup);
      sameGroupMap.set(scenario.id, refGroup);
    }
  });

  monthScenarios.forEach((scenario) => {
    resolveDepth(scenario.id);
  });

  const rows = new Map();
  monthScenarios.forEach((scenario) => {
    const depth = depthMap.get(scenario.id) ?? 0;
    const group = sameGroupMap.get(scenario.id) ?? new Set([scenario.id]);
    const maxDepth = Math.max(...[...group].map((id) => depthMap.get(id) ?? 0));
    rows.set(scenario.id, maxDepth);
  });

  const connectedSet = new Set();
  monthScenarios.forEach((scenarioA, index) => {
    monthScenarios.slice(index + 1).forEach((scenarioB) => {
      if (hasSameParticipantName(scenarioA, scenarioB)) {
        connectedSet.add(scenarioA.id);
        connectedSet.add(scenarioB.id);
      }
    });
  });

  const rowGroups = new Map();
  monthScenarios.forEach((scenario) => {
    const row = rows.get(scenario.id) ?? 0;
    if (!rowGroups.has(row)) rowGroups.set(row, []);
    rowGroups.get(row).push(scenario);
  });

  function buildSameComponents(rowScenarios) {
    const adjacency = new Map(rowScenarios.map((scenario) => [scenario.id, new Set()]));

    rowScenarios.forEach((scenario) => {
      const refId = scenario.placement?.relation === 'same' ? scenario.placement.referenceScenarioId : null;
      if (!refId || !adjacency.has(refId)) return;
      adjacency.get(scenario.id).add(refId);
      adjacency.get(refId).add(scenario.id);
    });

    const visited = new Set();
    const groups = [];
    rowScenarios.forEach((scenario) => {
      if (visited.has(scenario.id)) return;
      const stack = [scenario.id];
      const group = [];
      visited.add(scenario.id);
      while (stack.length) {
        const currentId = stack.pop();
        const currentScenario = scenarioMap.get(currentId);
        if (currentScenario && rowScenarios.some((item) => item.id === currentId)) {
          group.push(currentScenario);
        }
        (adjacency.get(currentId) || []).forEach((neighborId) => {
          if (visited.has(neighborId)) return;
          visited.add(neighborId);
          stack.push(neighborId);
        });
      }
      groups.push(group.sort(compareWithinSameGroup));
    });

    return groups;
  }

  function hasSameMonthPlacementLink(sourceScenario, targetScenario) {
    if (!sourceScenario || !targetScenario) return false;
    if (sourceScenario.year !== targetScenario.year || sourceScenario.month !== targetScenario.month) {
      return false;
    }

    const sourceRefId = sourceScenario.placement?.referenceScenarioId || null;
    const targetRefId = targetScenario.placement?.referenceScenarioId || null;

    return sourceRefId === targetScenario.id || targetRefId === sourceScenario.id;
  }

  function getPlacedConnectionColumns(scenario, placedById) {
    const candidates = [];
    placedById.forEach((column, placedId) => {
      const placedScenario = scenarioMap.get(placedId);
      if (!placedScenario) return;

      const hasParticipantConnection = hasSameParticipantName(scenario, placedScenario);
      const hasPlacementConnection = hasSameMonthPlacementLink(scenario, placedScenario);
      if (!hasParticipantConnection && !hasPlacementConnection) return;

      candidates.push({ scenario: placedScenario, column, row: rows.get(placedId) ?? 0 });
    });

    return candidates.sort((a, b) => {
      const rowDiff = b.row - a.row;
      if (rowDiff !== 0) return rowDiff;
      return a.column - b.column;
    });
  }

  function findNearestFreeColumn(targetColumn, rowTaken, usedColumns) {
    const maxColumn = Math.max(targetColumn + 1, usedColumns.size + rowTaken.size + 2);
    for (let offset = 0; offset <= maxColumn + 2; offset += 1) {
      const left = targetColumn - offset;
      if (left >= 0 && !rowTaken.has(left)) return left;
      const right = targetColumn + offset;
      if (!rowTaken.has(right)) return right;
    }
    return Math.max(0, targetColumn);
  }

  function findLeftmostFreeColumn(rowTaken, usedColumns) {
    const limit = usedColumns.size + rowTaken.size + 2;
    for (let column = 0; column <= limit; column += 1) {
      if (!rowTaken.has(column)) return column;
    }
    return limit + 1;
  }

  const xColumns = new Map();
  const placedById = placementState?.placedById || new Map();
  const usedColumns = placementState?.usedColumns || new Set();

  [...rowGroups.keys()].sort((a, b) => a - b).forEach((row) => {
    const rowScenarios = rowGroups.get(row).slice().sort(compareVisualTie);
    const rowTaken = new Set();
    const rowPlaced = new Set();
    const sameComponents = buildSameComponents(rowScenarios);
    const sameComponentById = new Map();

    sameComponents.forEach((group, index) => {
      group.forEach((scenario) => {
        sameComponentById.set(scenario.id, { index, group });
      });
    });

    const anchored = [];
    rowScenarios.forEach((scenario) => {
      const connectedColumns = getPlacedConnectionColumns(scenario, placedById);
      if (!connectedColumns.length) return;
      anchored.push({
        scenario,
        targetColumn: connectedColumns[0].column,
        connectedColumns
      });
    });

    const anchoredByTarget = new Map();
    anchored.forEach((entry) => {
      if (!anchoredByTarget.has(entry.targetColumn)) anchoredByTarget.set(entry.targetColumn, []);
      anchoredByTarget.get(entry.targetColumn).push(entry);
    });

    [...anchoredByTarget.keys()].sort((a, b) => a - b).forEach((targetColumn) => {
      const entries = anchoredByTarget.get(targetColumn).sort((a, b) => compareLowPriorityFirst(a.scenario, b.scenario));
      entries.forEach((entry, index) => {
        const column = index === 0 && !rowTaken.has(targetColumn)
          ? targetColumn
          : findNearestFreeColumn(targetColumn, rowTaken, usedColumns);
        xColumns.set(entry.scenario.id, column);
        placedById.set(entry.scenario.id, column);
        rowPlaced.add(entry.scenario.id);
        rowTaken.add(column);
        usedColumns.add(column);
      });
    });

    const sameExpansionEntries = [];
    sameComponents.forEach((group) => {
      const anchoredMembers = group.filter((scenario) => rowPlaced.has(scenario.id));
      const unplacedMembers = group.filter((scenario) => !rowPlaced.has(scenario.id));
      if (!anchoredMembers.length || !unplacedMembers.length) return;

      const anchorColumn = Math.min(...anchoredMembers.map((scenario) => xColumns.get(scenario.id) ?? 0));
      const orderedMembers = unplacedMembers.sort(compareWithinSameGroup);
      orderedMembers.forEach((scenario, offset) => {
        sameExpansionEntries.push({ scenario, targetColumn: anchorColumn + anchoredMembers.length + offset });
      });
    });

    sameExpansionEntries
      .sort((a, b) => a.targetColumn - b.targetColumn || compareWithinSameGroup(a.scenario, b.scenario))
      .forEach((entry) => {
        if (rowPlaced.has(entry.scenario.id)) return;
        const column = rowTaken.has(entry.targetColumn)
          ? findNearestFreeColumn(entry.targetColumn, rowTaken, usedColumns)
          : entry.targetColumn;
        xColumns.set(entry.scenario.id, column);
        placedById.set(entry.scenario.id, column);
        rowPlaced.add(entry.scenario.id);
        rowTaken.add(column);
        usedColumns.add(column);
      });

    const deferredGroups = sameComponents
      .filter((group) => group.some((scenario) => !rowPlaced.has(scenario.id)))
      .sort((groupA, groupB) => {
        const priorityDiff = Math.max(...groupB.map(getScenarioPriority)) - Math.max(...groupA.map(getScenarioPriority));
        if (priorityDiff !== 0) return priorityDiff;
        return groupA[0].title.localeCompare(groupB[0].title);
      });

    deferredGroups.forEach((group) => {
      const remaining = group.filter((scenario) => !rowPlaced.has(scenario.id)).sort(compareWithinSameGroup);
      if (!remaining.length) return;
      let column = findLeftmostFreeColumn(rowTaken, usedColumns);
      remaining.forEach((scenario, index) => {
        const nextColumn = index === 0 ? column : findNearestFreeColumn(column + index, rowTaken, usedColumns);
        xColumns.set(scenario.id, nextColumn);
        placedById.set(scenario.id, nextColumn);
        rowPlaced.add(scenario.id);
        rowTaken.add(nextColumn);
        usedColumns.add(nextColumn);
      });
    });

    rowScenarios
      .filter((scenario) => !rowPlaced.has(scenario.id))
      .sort(compareLowPriorityFirst)
      .forEach((scenario) => {
        const column = findLeftmostFreeColumn(rowTaken, usedColumns);
        xColumns.set(scenario.id, column);
        placedById.set(scenario.id, column);
        rowPlaced.add(scenario.id);
        rowTaken.add(column);
        usedColumns.add(column);
      });
  });

  const orderedIds = monthScenarios
    .slice()
    .sort((a, b) => {
      const rowDiff = (rows.get(a.id) ?? 0) - (rows.get(b.id) ?? 0);
      if (rowDiff !== 0) return rowDiff;
      return (xColumns.get(a.id) ?? 0) - (xColumns.get(b.id) ?? 0);
    })
    .map((scenario) => scenario.id);

  const xMap = new Map();
  const laneWidth = 240;
  const laneGap = 70;

  orderedIds.forEach((id) => {
    xMap.set(id, (xColumns.get(id) ?? 0) * (laneWidth + laneGap));
  });

  return monthScenarios.map((scenario) => ({
    ...scenario,
    x: xMap.get(scenario.id) ?? 0,
    y: (rows.get(scenario.id) ?? 0) * 120,
    connected: connectedSet.has(scenario.id)
  }));
}

function getPlacementSummary(scenario) {
  if (!scenario.placement) {
    return '未設定';
  }

  const reference = getScenarioById(scenario.placement.referenceScenarioId);
  const referenceTitle = reference ? reference.title : '未参照';

  if (scenario.placement.relation === 'same') {
    return `same : ${referenceTitle}と同じ`;
  }

  if (scenario.placement.relation === 'after') {
    return `after : ${referenceTitle}の後`;
  }

  return `${scenario.placement.relation} : ${referenceTitle}`;
}

function getStoryLaneKey(scenario) {
  return Array.isArray(scenario?.tags) && scenario.tags[0] ? scenario.tags[0] : '__untagged__';
}

function getStoryTag(scenario) {
  const storyTagId = getStoryLaneKey(scenario);
  return storyTagId === '__untagged__' ? null : getTagById(storyTagId);
}

function getConnectionColor(connection) {
  const sourceTag = getStoryTag(connection.scenarioA);
  const targetTag = getStoryTag(connection.scenarioB);
  return sourceTag && targetTag ? sourceTag.color : null;
}

function computeStoryLaneLayout(scenarios) {
  const scenariosByMonth = new Map();
  scenarios.forEach((scenario) => {
    const key = getMonthKey(scenario);
    if (!scenariosByMonth.has(key)) scenariosByMonth.set(key, []);
    scenariosByMonth.get(key).push(scenario);
  });

  const rowById = new Map();
  scenariosByMonth.forEach((monthScenarios) => {
    const scenarioMap = new Map(monthScenarios.map((scenario) => [scenario.id, scenario]));
    const depthById = new Map();
    const resolveDepth = (scenarioId, seen = new Set()) => {
      if (seen.has(scenarioId)) return 0;
      if (depthById.has(scenarioId)) return depthById.get(scenarioId);
      seen.add(scenarioId);
      const scenario = scenarioMap.get(scenarioId);
      const reference = scenario?.placement ? scenarioMap.get(scenario.placement.referenceScenarioId) : null;
      const depth = reference ? resolveDepth(reference.id, seen) + (scenario.placement.relation === 'after' ? 1 : 0) : 0;
      depthById.set(scenarioId, depth);
      return depth;
    };
    const adjacency = new Map(monthScenarios.map((scenario) => [scenario.id, new Set()]));
    monthScenarios.forEach((scenario) => {
      const referenceId = scenario.placement?.relation === 'same' ? scenario.placement.referenceScenarioId : null;
      if (!referenceId || !adjacency.has(referenceId)) return;
      adjacency.get(scenario.id).add(referenceId);
      adjacency.get(referenceId).add(scenario.id);
    });
    const visited = new Set();
    monthScenarios.forEach((scenario) => {
      if (visited.has(scenario.id)) return;
      const component = [];
      const stack = [scenario.id];
      visited.add(scenario.id);
      while (stack.length) {
        const currentId = stack.pop();
        component.push(currentId);
        adjacency.get(currentId).forEach((neighborId) => {
          if (visited.has(neighborId)) return;
          visited.add(neighborId);
          stack.push(neighborId);
        });
      }
      const row = Math.max(...component.map((id) => resolveDepth(id)));
      component.forEach((id) => rowById.set(id, row));
    });
  });

  const getTimelineOrder = (scenario) => (scenario.year * 12 + scenario.month) * 1000 + (rowById.get(scenario.id) ?? 0);
  const stories = new Map();
  scenarios.forEach((scenario, index) => {
    const key = getStoryLaneKey(scenario);
    const order = getTimelineOrder(scenario);
    if (!stories.has(key)) stories.set(key, { key, start: order, end: order, firstIndex: index, width: 1, branchById: new Map() });
    const story = stories.get(key);
    story.start = Math.min(story.start, order);
    story.end = Math.max(story.end, order);
  });

  const scenariosByStoryRow = new Map();
  scenarios.forEach((scenario) => {
    const key = `${getStoryLaneKey(scenario)}:${getTimelineOrder(scenario)}`;
    if (!scenariosByStoryRow.has(key)) scenariosByStoryRow.set(key, []);
    scenariosByStoryRow.get(key).push(scenario);
  });
  scenariosByStoryRow.forEach((rowScenarios) => {
    const story = stories.get(getStoryLaneKey(rowScenarios[0]));
    rowScenarios.slice().sort((a, b) => {
      const priorityDiff = Number(b.xPriority ?? 1) - Number(a.xPriority ?? 1);
      return priorityDiff || a.title.localeCompare(b.title);
    }).forEach((scenario, index) => story.branchById.set(scenario.id, index));
    story.width = Math.max(story.width, rowScenarios.length);
  });

  const assignedStories = [];
  [...stories.values()]
    .filter((story) => story.key !== '__untagged__')
    .sort((a, b) => a.start - b.start || a.firstIndex - b.firstIndex || a.key.localeCompare(b.key))
    .forEach((story) => {
      const activeStories = assignedStories.filter((assigned) => assigned.end >= story.start);
      let column = 0;
      while (activeStories.some((assigned) => column < assigned.column + assigned.width && column + story.width > assigned.column)) column += 1;
      story.column = column;
      assignedStories.push(story);
    });

  const untaggedStory = stories.get('__untagged__');
  if (untaggedStory) {
    untaggedStory.column = assignedStories.reduce((rightmost, story) => Math.max(rightmost, story.column + story.width), 0);
  }

  const connectedIds = new Set();
  scenariosByMonth.forEach((monthScenarios) => {
    monthScenarios.forEach((scenario, index) => monthScenarios.slice(index + 1).forEach((otherScenario) => {
      if (hasSameParticipantName(scenario, otherScenario)) {
        connectedIds.add(scenario.id);
        connectedIds.add(otherScenario.id);
      }
    }));
  });

  const layoutById = new Map();
  scenarios.forEach((scenario) => {
    const story = stories.get(getStoryLaneKey(scenario));
    layoutById.set(scenario.id, {
      x: (story.column + (story.branchById.get(scenario.id) ?? 0)) * 280,
      y: (rowById.get(scenario.id) ?? 0) * 120,
      connected: connectedIds.has(scenario.id)
    });
  });
  return layoutById;
}

function selectScenario(scenarioId) {
  if (!scenarioId) {
    return;
  }

  state.selectedScenarioId = scenarioId;
  render();
}

function renderScenarioList() {
  scenarioListEl.innerHTML = '';

  const visibleScenarios = getVisibleScenarios();
  visibleScenarios
    .slice()
    .sort((a, b) => {
      const dateA = a.year * 12 + a.month;
      const dateB = b.year * 12 + b.month;
      return dateA - dateB || a.title.localeCompare(b.title);
    })
    .forEach((scenario) => {
      const button = document.createElement('button');
      button.className = 'list-item';
      button.type = 'button';
      button.innerHTML = `
        <span class="small-title">${scenario.title}</span>
        <span class="small-date">${getMonthLabel(scenario.year, scenario.month)}</span>
      `;
      button.addEventListener('click', () => selectScenario(scenario.id));
      scenarioListEl.appendChild(button);
    });
}

function deleteScenario(scenarioId) {
  const scenario = getScenarioById(scenarioId);
  if (!scenario) return;

  const confirmed = window.confirm(`${scenario.title}を削除しますか？`);
  if (!confirmed) return;

  const replacementReferenceId = scenario.placement?.referenceScenarioId || null;

  state.scenarios = state.scenarios
    .filter((item) => item.id !== scenarioId)
    .map((item) => {
      if (!item.placement || item.placement.referenceScenarioId !== scenarioId) {
        return item;
      }

      return {
        ...item,
        placement: replacementReferenceId
          ? { ...item.placement, referenceScenarioId: replacementReferenceId }
          : null
      };
    });

  state.selectedScenarioId = state.scenarios[0]?.id || null;
  closeScenarioModal();
  render();
}

function renderDetailPanel() {
  const visibleScenarios = getVisibleScenarios();
  const selected = getSelectedScenario(visibleScenarios, state.selectedScenarioId);
  if (!selected) {
    const message = state.search.active
      ? '検索条件に一致するシナリオがありません'
      : '対象のシナリオがありません';
    detailPanelEl.innerHTML = `<div class="empty-state">${message}</div>`;
    return;
  }

  detailPanelEl.innerHTML = `
    <div class="detail-card">
      <h3>${selected.title}</h3>
      <div class="meta-row">
        <span class="tag">${getMonthLabel(selected.year, selected.month)}</span>
        <span class="tag">${selected.summary}</span>
      </div>
      <div class="section-label">時系列</div>
      <p class="detail-text">${getPlacementSummary(selected)}</p>
      <div class="section-label">GM</div>
      <div class="meta-row">${selected.gm ? `<span class="tag">${selected.gm}</span>` : '<span class="tag">なし</span>'}</div>
      <div class="section-label">舞台</div>
      <div class="meta-row">${selected.stage ? `<span class="tag">${selected.stage}</span>` : '<span class="tag">未設定</span>'}</div>
      <div class="section-label">タグ</div>
      <div class="meta-row">${getScenarioTags(selected).length ? getScenarioTags(selected).map((tag) => `<span class="tag" style="background:${tag.color}; color:white;">${tag.name}</span>`).join('') : '<span class="tag">なし</span>'}</div>
      <div class="section-label">参加PC</div>
      <div class="meta-row">${selected.pcs.map((value) => `<span class="tag">${value}</span>`).join('') || '<span class="tag">なし</span>'}</div>
      <div class="section-label">登場NPC</div>
      <div class="meta-row">${selected.npcs.map((value) => `<span class="tag">${value}</span>`).join('') || '<span class="tag">なし</span>'}</div>
      <div class="section-label">トレーラー</div>
      <p class="detail-text">${selected.information.trailer || 'なし'}</p>
      <div class="section-label">詳細</div>
      <p class="detail-text">${selected.information.description || '詳細なし'}</p>
      <div class="detail-actions">
        <button id="edit-scenario-btn" class="secondary-btn" type="button">編集</button>
      </div>
    </div>
  `;

  const editButton = detailPanelEl.querySelector('#edit-scenario-btn');
  if (editButton) {
    editButton.addEventListener('click', () => openScenarioModal(selected.id));
  }
}

function renderTimeline() {
  const visibleScenarios = getVisibleScenarios();

  if (!visibleScenarios.length) {
    timelineEl.innerHTML = '<div class="empty-state">検索条件に一致するシナリオがありません</div>';
    return;
  }

  const monthMap = groupScenariosByMonth(visibleScenarios);
  const monthKeys = sortMonthKeys(monthMap.keys());

  const allRendered = [];
  const layoutById = computeStoryLaneLayout(state.scenarios);

  monthKeys.forEach((monthKey) => {
    const monthScenarios = monthMap.get(monthKey);
    const rendered = monthScenarios.map((scenario) => ({
      ...scenario,
      ...(layoutById.get(scenario.id) || { x: 0, y: 0, connected: false })
    }));
    allRendered.push({ key: monthKey, scenarios: rendered });
  });

  const maxX = Math.max(
    0,
    ...allRendered.flatMap((group) => group.scenarios.map((scenario) => scenario.x + 220))
  );

  const timelineMarkup = `
    <div class="timeline-zoom-layer">
      ${allRendered
        .map(({ key, scenarios }, index) => {
          const [year, month] = key.split('-').map(Number);
          const cards = scenarios
            .map((scenario) => {
              const selected = scenario.id === state.selectedScenarioId ? 'selected' : '';
              const connected = scenario.connected ? 'connected' : '';
              const tagGradient = getScenarioTagGradient(scenario);
              const tagMarkup = getScenarioTags(scenario).length
                ? `<div class="scenario-tag-strip" style="${tagGradient ? `background: ${tagGradient};` : ''}"></div>`
                : '<div class="scenario-tag-strip empty"></div>';
              return `
                <div class="scenario-card ${connected} ${selected}" data-scenario-id="${scenario.id}" style="left: ${scenario.x}px; top: ${scenario.y}px;">
                  ${tagMarkup}
                  <div class="scenario-title">${scenario.title}</div>
                  <div class="scenario-summary">${scenario.summary}</div>
                </div>
              `;
            })
            .join('');

          return `
            <section class="month-group">
              <div class="month-header">
                <span class="month-label">${getMonthLabel(year, month)}</span>
                <span class="month-divider ${index < allRendered.length - 1 ? 'dashed' : ''}"></span>
              </div>
              <div class="timeline-layer" style="width: ${Math.max(maxX + 40, 680)}px; height: ${Math.max(200, (Math.max(...scenarios.map((scenario) => scenario.y + 120), 0)) + 24)}px;">
                ${cards}
              </div>
            </section>
          `;
        })
        .join('')}
    </div>
  `;

  timelineEl.innerHTML = timelineMarkup;

  const scenarioCards = [...document.querySelectorAll('.scenario-card')];
  scenarioCards.forEach((card) => {
    const id = card.getAttribute('data-scenario-id');
    card.addEventListener('click', () => selectScenario(id));
    card.addEventListener('dblclick', () => {
      if (id) {
        openScenarioModal(id);
      }
    });
  });

  drawConnections(visibleScenarios);
}

function getTimelineScale() {
  const raw = getComputedStyle(timelineEl).getPropertyValue('--timeline-scale');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function getRectFromCard(card, timelineRect) {
  const scale = getTimelineScale();
  const rect = card.getBoundingClientRect();
  const left = (rect.left - timelineRect.left) / scale;
  const top = (rect.top - timelineRect.top) / scale;
  const width = rect.width / scale;
  const height = rect.height / scale;

  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    cx: left + width / 2,
    cy: top + height / 2
  };
}

function rectIntersectsSegment(rect, p1, p2) {
  const padding = 18;
  const minX = Math.min(p1.x, p2.x) - padding;
  const maxX = Math.max(p1.x, p2.x) + padding;
  const minY = Math.min(p1.y, p2.y) - padding;
  const maxY = Math.max(p1.y, p2.y) + padding;

  const inflatedRect = {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding
  };

  const rectMinX = inflatedRect.left;
  const rectMinY = inflatedRect.top;
  const rectMaxX = inflatedRect.right;
  const rectMaxY = inflatedRect.bottom;

  return !(maxX < rectMinX || minX > rectMaxX || maxY < rectMinY || minY > rectMaxY);
}

function inflateRect(rect, padding) {
  return {
    left: rect.left - padding,
    top: rect.top - padding,
    right: rect.right + padding,
    bottom: rect.bottom + padding
  };
}

function segmentIntersectsInflatedRect(p1, p2, rect, padding = 12) {
  const inflated = inflateRect(rect, padding);
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  if (Math.abs(p1.x - p2.x) < 0.01) {
    return p1.x >= inflated.left && p1.x <= inflated.right && maxY >= inflated.top && minY <= inflated.bottom;
  }

  if (Math.abs(p1.y - p2.y) < 0.01) {
    return p1.y >= inflated.top && p1.y <= inflated.bottom && maxX >= inflated.left && minX <= inflated.right;
  }

  return rectIntersectsSegment(inflated, p1, p2);
}

function routeIntersectsAnyCard(points, cardEntries, protectedCards) {
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];

    for (let cardIndex = 0; cardIndex < cardEntries.length; cardIndex += 1) {
      const { card, rect } = cardEntries[cardIndex];
      if (protectedCards.has(card)) continue;
      if (segmentIntersectsInflatedRect(start, end, rect, 8)) {
        return true;
      }
    }
  }

  return false;
}

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
}

function buildAxisCandidates(intervals, preferred, fallbackMin, fallbackMax, gapPadding = 16) {
  const candidates = [preferred, fallbackMin, fallbackMax];
  if (!intervals.length) {
    return uniqueSortedNumbers(candidates);
  }

  const sorted = intervals.slice().sort((a, b) => a.left - b.left);
  candidates.push(sorted[0].left - gapPadding, sorted[sorted.length - 1].right + gapPadding);

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (next.left - current.right >= gapPadding * 2) {
      candidates.push((current.right + next.left) / 2);
    }
  }

  return uniqueSortedNumbers(candidates);
}

function scoreOrthogonalRoute(points, preferredAxisValue, preferVertical) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    length += Math.abs(points[index].x - points[index + 1].x) + Math.abs(points[index].y - points[index + 1].y);
  }

  const bendPenalty = Math.max(0, points.length - 2) * 12;
  const axisValue = preferVertical ? points[1]?.x : points[1]?.y;
  const axisPenalty = preferredAxisValue == null || axisValue == null ? 0 : Math.abs(axisValue - preferredAxisValue);
  return length + bendPenalty + axisPenalty;
}

function simplifyOrthogonalPoints(points) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];

  const epsilon = 0.01;
  const deduped = dedupeConsecutivePoints(points);
  if (deduped.length <= 2) return deduped;

  const simplified = [deduped[0]];
  for (let index = 1; index < deduped.length - 1; index += 1) {
    const prev = simplified[simplified.length - 1];
    const current = deduped[index];
    const next = deduped[index + 1];

    const sameX = Math.abs(prev.x - current.x) < epsilon && Math.abs(current.x - next.x) < epsilon;
    const sameY = Math.abs(prev.y - current.y) < epsilon && Math.abs(current.y - next.y) < epsilon;
    if (sameX || sameY) {
      continue;
    }

    simplified.push(current);
  }

  simplified.push(deduped[deduped.length - 1]);
  return dedupeConsecutivePoints(simplified);
}

const DETOUR_LANE_SPACING = 12;
const MIN_PARALLEL_ROUTE_GAP = 12;
const DETOUR_STEM_LENGTH = 8;

function rangesOverlap(minA, maxA, minB, maxB, margin = 0) {
  return maxA >= minB - margin && maxB >= minA - margin;
}

function getPreferredDetourAxisAndSpan(connection) {
  const sourceAboveTarget = connection.rectA.cy < connection.rectB.cy;
  const sourceLeftOfTarget = connection.rectA.cx < connection.rectB.cx;

  if (connection.preferVertical) {
    const startY = sourceAboveTarget
      ? connection.rectA.bottom + DETOUR_STEM_LENGTH
      : connection.rectA.top - DETOUR_STEM_LENGTH;
    const endY = sourceAboveTarget
      ? connection.rectB.top - DETOUR_STEM_LENGTH
      : connection.rectB.bottom + DETOUR_STEM_LENGTH;
    return {
      axis: (connection.rectA.cx + connection.rectB.cx) / 2,
      spanMin: Math.min(startY, endY),
      spanMax: Math.max(startY, endY)
    };
  }

  const startX = sourceLeftOfTarget
    ? connection.rectA.right + DETOUR_STEM_LENGTH
    : connection.rectA.left - DETOUR_STEM_LENGTH;
  const endX = sourceLeftOfTarget
    ? connection.rectB.left - DETOUR_STEM_LENGTH
    : connection.rectB.right + DETOUR_STEM_LENGTH;
  return {
    axis: (connection.rectA.cy + connection.rectB.cy) / 2,
    spanMin: Math.min(startX, endX),
    spanMax: Math.max(startX, endX)
  };
}

function getPreferredLaneOrder(limit = 16) {
  const order = [0];
  for (let index = 1; index <= limit; index += 1) {
    order.push(index, -index);
  }
  return order;
}

function assignConnectionDetourLanes(connections) {
  const vertical = [];
  const horizontal = [];

  connections.forEach((connection) => {
    const meta = getPreferredDetourAxisAndSpan(connection);
    connection.routeLane = 0;
    connection.routeMeta = meta;
    if (connection.preferVertical) {
      vertical.push(connection);
    } else {
      horizontal.push(connection);
    }
  });

  const laneOrder = getPreferredLaneOrder(20);

  function assignByOverlap(group) {
    const assigned = [];
    group
      .slice()
      .sort((a, b) => {
        const axisDiff = a.routeMeta.axis - b.routeMeta.axis;
        if (Math.abs(axisDiff) > 0.01) return axisDiff;
        const spanDiff = a.routeMeta.spanMin - b.routeMeta.spanMin;
        if (Math.abs(spanDiff) > 0.01) return spanDiff;
        return a.scenarioA.id.localeCompare(b.scenarioA.id) || a.scenarioB.id.localeCompare(b.scenarioB.id);
      })
      .forEach((connection) => {
        const overlapping = assigned.filter((other) => rangesOverlap(
          connection.routeMeta.spanMin,
          connection.routeMeta.spanMax,
          other.routeMeta.spanMin,
          other.routeMeta.spanMax,
          2
        ));

        let chosenLane = 0;
        for (let index = 0; index < laneOrder.length; index += 1) {
          const candidateLane = laneOrder[index];
          const candidateAxis = connection.routeMeta.axis + candidateLane * DETOUR_LANE_SPACING;
          const hasConflict = overlapping.some((other) => {
            const otherAxis = other.routeMeta.axis + other.routeLane * DETOUR_LANE_SPACING;
            return Math.abs(candidateAxis - otherAxis) < MIN_PARALLEL_ROUTE_GAP;
          });
          if (!hasConflict) {
            chosenLane = candidateLane;
            break;
          }
        }

        connection.routeLane = chosenLane;
        assigned.push(connection);
      });
  }

  assignByOverlap(vertical);
  assignByOverlap(horizontal);
}

function buildAvoidingOrthogonalPath(connection, cardRects, cards) {
  const protectedCards = new Set([connection.a, connection.b]);
  const sourceRect = connection.rectA;
  const targetRect = connection.rectB;
  const sourceCenterX = sourceRect.cx;
  const sourceCenterY = sourceRect.cy;
  const targetCenterX = targetRect.cx;
  const targetCenterY = targetRect.cy;

  const preferVertical = connection.preferVertical;
  const stemLength = DETOUR_STEM_LENGTH;
  const detourOffset = (connection.routeLane || 0) * DETOUR_LANE_SPACING;

  const buildVertical = (bridgeX) => {
    const sourceAboveTarget = sourceCenterY < targetCenterY;
    const start = {
      x: sourceCenterX,
      y: sourceAboveTarget ? sourceRect.bottom : sourceRect.top
    };
    const end = {
      x: targetCenterX,
      y: sourceAboveTarget ? targetRect.top : targetRect.bottom
    };
    const startExit = {
      x: start.x,
      y: sourceAboveTarget ? start.y + stemLength : start.y - stemLength
    };
    const endExit = {
      x: end.x,
      y: sourceAboveTarget ? end.y - stemLength : end.y + stemLength
    };

    return [
      start,
      startExit,
      { x: bridgeX + detourOffset, y: startExit.y },
      { x: bridgeX + detourOffset, y: endExit.y },
      endExit,
      end
    ];
  };

  const buildHorizontal = (bridgeY) => {
    const sourceLeftOfTarget = sourceCenterX < targetCenterX;
    const start = {
      x: sourceLeftOfTarget ? sourceRect.right : sourceRect.left,
      y: sourceCenterY
    };
    const end = {
      x: sourceLeftOfTarget ? targetRect.left : targetRect.right,
      y: targetCenterY
    };
    const startExit = {
      x: sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength,
      y: start.y
    };
    const endExit = {
      x: sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength,
      y: end.y
    };

    return [
      start,
      startExit,
      { x: startExit.x, y: bridgeY + detourOffset },
      { x: endExit.x, y: bridgeY + detourOffset },
      endExit,
      end
    ];
  };

  const evaluateCandidates = (builder, axisCandidates, preferredAxisValue) => {
    let best = null;
    axisCandidates.forEach((axisValue) => {
      const points = simplifyOrthogonalPoints(builder(axisValue));
      if (routeIntersectsAnyCard(points, cardEntries, protectedCards)) {
        return;
      }

      const score = scoreOrthogonalRoute(points, preferredAxisValue, preferVertical);
      if (!best || score < best.score) {
        best = { points, score };
      }
    });
    return best?.points || null;
  };

  const cardEntries = cardRects.map((rect, index) => ({ rect, card: cards[index] }));
  const otherRects = cardEntries.filter((entry) => !protectedCards.has(entry.card));

  const buildPreferredNoDetourPath = () => {
    if (preferVertical) {
      const sourceAboveTarget = sourceCenterY < targetCenterY;
      const start = {
        x: sourceCenterX,
        y: sourceAboveTarget ? sourceRect.bottom : sourceRect.top
      };
      const end = {
        x: targetCenterX,
        y: sourceAboveTarget ? targetRect.top : targetRect.bottom
      };
      const startExit = {
        x: start.x,
        y: sourceAboveTarget ? start.y + stemLength : start.y - stemLength
      };
      const endExit = {
        x: end.x,
        y: sourceAboveTarget ? end.y - stemLength : end.y + stemLength
      };
      const bridgeX = (sourceCenterX + targetCenterX) / 2;
      return simplifyOrthogonalPoints([
        start,
        startExit,
        { x: bridgeX + detourOffset, y: startExit.y },
        { x: bridgeX + detourOffset, y: endExit.y },
        endExit,
        end
      ]);
    }

    const sourceLeftOfTarget = sourceCenterX < targetCenterX;
    const start = {
      x: sourceLeftOfTarget ? sourceRect.right : sourceRect.left,
      y: sourceCenterY
    };
    const end = {
      x: sourceLeftOfTarget ? targetRect.left : targetRect.right,
      y: targetCenterY
    };
    const startExit = {
      x: sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength,
      y: start.y
    };
    const endExit = {
      x: sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength,
      y: end.y
    };
    const bridgeY = (sourceCenterY + targetCenterY) / 2;
    return simplifyOrthogonalPoints([
      start,
      startExit,
      { x: startExit.x, y: bridgeY + detourOffset },
      { x: endExit.x, y: bridgeY + detourOffset },
      endExit,
      end
    ]);
  };

  if (preferVertical) {
    const sourceAboveTarget = sourceCenterY < targetCenterY;
    const start = sourceAboveTarget ? sourceRect.bottom : sourceRect.top;
    const end = sourceAboveTarget ? targetRect.top : targetRect.bottom;
    const minY = Math.min(start, end) - stemLength - 6;
    const maxY = Math.max(start, end) + stemLength + 6;
    const blockingRects = otherRects.filter((entry) => entry.rect.bottom >= minY && entry.rect.top <= maxY);
    const intervals = blockingRects.map((entry) => inflateRect(entry.rect, 10));
    const preferred = (sourceCenterX + targetCenterX) / 2;
    const axisCandidates = buildAxisCandidates(intervals, preferred, 24, Math.max(24, Math.max(...cardRects.map((rect) => rect.right), 0) + 64));
    const bestVertical = evaluateCandidates(buildVertical, axisCandidates, preferred);
    if (bestVertical) return bestVertical;
    return null;
  }

  {
    const sourceLeftOfTarget = sourceCenterX < targetCenterX;
    const start = sourceLeftOfTarget ? sourceRect.right : sourceRect.left;
    const end = sourceLeftOfTarget ? targetRect.left : targetRect.right;
    const minX = Math.min(start, end) - stemLength - 6;
    const maxX = Math.max(start, end) + stemLength + 6;
    const blockingRects = otherRects.filter((entry) => entry.rect.right >= minX && entry.rect.left <= maxX);
    const intervals = blockingRects.map((entry) => inflateRect(entry.rect, 10));
    const preferred = (sourceCenterY + targetCenterY) / 2;
    const axisCandidates = buildAxisCandidates(intervals, preferred, 24, Math.max(24, Math.max(...cardRects.map((rect) => rect.bottom), 0) + 64));
    const bestHorizontal = evaluateCandidates(buildHorizontal, axisCandidates, preferred);
    if (bestHorizontal) return bestHorizontal;
  }

  return null;
}

function createOrthogonalPolyline(start, end, laneBias, preferVertical) {
  if (preferVertical) {
    const x1 = start.x + laneBias;
    const x2 = end.x + laneBias;
    const midY = (start.y + end.y) / 2;

    return [
      { x: x1, y: start.y },
      { x: x1, y: midY },
      { x: x2, y: midY },
      { x: x2, y: end.y }
    ];
  }

  const y1 = start.y + laneBias;
  const y2 = end.y + laneBias;
  const midX = (start.x + end.x) / 2;

  return [
    { x: start.x, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: end.x, y: y2 }
  ];
}

function dedupeConsecutivePoints(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const result = [points[0]];

  for (let index = 1; index < points.length; index += 1) {
    const prev = result[result.length - 1];
    const current = points[index];
    if (Math.abs(prev.x - current.x) < 0.01 && Math.abs(prev.y - current.y) < 0.01) {
      continue;
    }
    result.push(current);
  }

  return result;
}

function getCenteredLaneIndex(index, total) {
  return index - (total - 1) / 2;
}

function assignConnectionLanesPerCardEdge(connections) {
  const edgeMap = new Map();

  connections.forEach((connection) => {
    const startKey = `${connection.scenarioA.id}:${connection.startEdge}`;
    const endKey = `${connection.scenarioB.id}:${connection.endEdge}`;

    if (!edgeMap.has(startKey)) edgeMap.set(startKey, []);
    if (!edgeMap.has(endKey)) edgeMap.set(endKey, []);

    edgeMap.get(startKey).push({ connection, side: 'start' });
    edgeMap.get(endKey).push({ connection, side: 'end' });
  });

  edgeMap.forEach((entries) => {
    entries.sort((a, b) => {
      const aCoord = a.side === 'start'
        ? (a.connection.preferVertical ? a.connection.rectB.cx : a.connection.rectB.cy)
        : (a.connection.preferVertical ? a.connection.rectA.cx : a.connection.rectA.cy);
      const bCoord = b.side === 'start'
        ? (b.connection.preferVertical ? b.connection.rectB.cx : b.connection.rectB.cy)
        : (b.connection.preferVertical ? b.connection.rectA.cx : b.connection.rectA.cy);
      return aCoord - bCoord;
    });

    const total = entries.length;
    entries.forEach((entry, index) => {
      const lane = getCenteredLaneIndex(index, total);
      if (entry.side === 'start') {
        entry.connection.startLane = lane;
      } else {
        entry.connection.endLane = lane;
      }
    });
  });
}

function snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards) {
  const protectedCards = new Set([connection.a, connection.b]);
  const snapped = points.map((point) => ({ ...point }));

  for (let i = 0; i < snapped.length - 1; i += 1) {
    const a = snapped[i];
    const b = snapped[i + 1];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const nearStart = Math.hypot(mid.x - start.x, mid.y - start.y) < 28;
    const nearEnd = Math.hypot(mid.x - end.x, mid.y - end.y) < 28;
    if (nearStart || nearEnd) continue;

    if (Math.abs(a.y - b.y) < 0.5) {
      const horizontalY = a.y;
      for (let index = 0; index < cardRects.length; index += 1) {
        const card = cards[index];
        if (protectedCards.has(card)) continue;
        const rect = cardRects[index];
        const isNearTop = Math.abs(horizontalY - rect.top) < 12;
        const isNearBottom = Math.abs(horizontalY - rect.bottom) < 12;
        if (!isNearTop && !isNearBottom) continue;
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const overlapsHorizontally = maxX >= rect.left - 6 && minX <= rect.right + 6;
        if (!overlapsHorizontally) continue;
        const edgeY = isNearTop ? rect.top : rect.bottom;
        const outsideOffset = isNearTop ? -8 : 8;
        a.y = edgeY + outsideOffset;
        b.y = edgeY + outsideOffset;
      }
    }

    if (Math.abs(a.x - b.x) < 0.5) {
      const verticalX = a.x;
      for (let index = 0; index < cardRects.length; index += 1) {
        const card = cards[index];
        if (protectedCards.has(card)) continue;
        const rect = cardRects[index];
        const isNearLeft = Math.abs(verticalX - rect.left) < 12;
        const isNearRight = Math.abs(verticalX - rect.right) < 12;
        if (!isNearLeft && !isNearRight) continue;
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        const overlapsVertically = maxY >= rect.top - 6 && minY <= rect.bottom + 6;
        if (!overlapsVertically) continue;
        const edgeX = isNearLeft ? rect.left : rect.right;
        const outsideOffset = isNearLeft ? -8 : 8;
        a.x = edgeX + outsideOffset;
        b.x = edgeX + outsideOffset;
      }
    }
  }

  return snapped;
}

function ensureConnectionTooltip() {
  let tooltip = document.getElementById('connection-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'connection-tooltip';
    tooltip.className = 'connection-tooltip hidden';
    timelineEl.appendChild(tooltip);
  }
  return tooltip;
}

function renderConnectionTooltip(event, connection) {
  const tooltip = ensureConnectionTooltip();
  if (!connection) return;

  const scenarioA = connection.scenarioA;
  const scenarioB = connection.scenarioB;
  if (!scenarioA || !scenarioB) return;

  const sharedNames = new Set(getSharedParticipants(scenarioA, scenarioB));
  const formatCategory = (items) => items.filter((item) => sharedNames.has(item));

  const aPc = formatCategory(scenarioA.pcs);
  const aNpc = formatCategory(scenarioA.npcs);
  const bPc = formatCategory(scenarioB.pcs);
  const bNpc = formatCategory(scenarioB.npcs);

  const buildSection = (label, items) => {
    if (items.length === 0) return '';
    return `<div class="connection-tooltip-section">${label}：${items.join('、')}</div>`;
  };

  tooltip.innerHTML = `
    <div class="connection-tooltip-title">${scenarioA.title}</div>
    ${buildSection('PC', aPc)}
    ${buildSection('NPC', aNpc)}
    <div class="connection-tooltip-title" style="margin-top: 8px;">${scenarioB.title}</div>
    ${buildSection('PC', bPc)}
    ${buildSection('NPC', bNpc)}
  `;

  tooltip.classList.remove('hidden');

  const maxLeft = Math.max(12, window.innerWidth - tooltip.offsetWidth - 12);
  const maxTop = Math.max(12, window.innerHeight - tooltip.offsetHeight - 12);
  tooltip.style.left = `${Math.min(event.clientX + 14, maxLeft)}px`;
  tooltip.style.top = `${Math.min(event.clientY + 18, maxTop)}px`;
}

function hideConnectionTooltip() {
  const tooltip = document.getElementById('connection-tooltip');
  if (tooltip) {
    tooltip.classList.add('hidden');
  }
}

function createConnectionLayerSvg(className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

function collectConnections(cards, visibleMap, timelineRect, validPairIds) {
  const connections = [];

  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) {
      const a = cards[i];
      const b = cards[j];
      const scenarioA = visibleMap.get(a.dataset.scenarioId);
      const scenarioB = visibleMap.get(b.dataset.scenarioId);
      if (!scenarioA || !scenarioB) continue;
      if (!hasSameParticipantName(scenarioA, scenarioB)) continue;

      const pairKey = getScenarioPairKey(scenarioA, scenarioB);
      if (!validPairIds.has(pairKey)) continue;

      const rectA = getRectFromCard(a, timelineRect);
      const rectB = getRectFromCard(b, timelineRect);
      const sameRelation = isSameRelation(scenarioA, scenarioB);
      const endpoints = getConnectionEndpoints(rectA, rectB, sameRelation);

      connections.push({
        a,
        b,
        rectA,
        rectB,
        sameRelation,
        ...endpoints,
        startLane: 0,
        endLane: 0,
        scenarioA,
        scenarioB
      });
    }
  }

  return connections;
}

function buildFallbackOrthogonalPath(connection, cardRects, cards) {
  const sourceCenterX = connection.rectA.cx;
  const sourceCenterY = connection.rectA.cy;
  const targetCenterX = connection.rectB.cx;
  const targetCenterY = connection.rectB.cy;
  const laneSeparation = 18;

  if (connection.preferVertical) {
    const sourceAboveTarget = sourceCenterY < targetCenterY;
    const start = {
      x: sourceCenterX,
      y: sourceAboveTarget ? connection.rectA.bottom : connection.rectA.top
    };
    const end = {
      x: targetCenterX,
      y: sourceAboveTarget ? connection.rectB.top : connection.rectB.bottom
    };

    const verticalDistance = Math.abs(end.y - start.y);
    const stemLength = Math.min(16, Math.max(8, Math.floor(verticalDistance / 4)));
    const startStemY = sourceAboveTarget ? start.y + stemLength : start.y - stemLength;
    const endStemY = sourceAboveTarget ? end.y - stemLength : end.y + stemLength;
    const interiorStart = { x: start.x + connection.startLane * laneSeparation, y: startStemY };
    const interiorEnd = { x: end.x + connection.endLane * laneSeparation, y: endStemY };
    const interiorPoints = createOrthogonalPolyline(interiorStart, interiorEnd, 0, true);
    let points = dedupeConsecutivePoints([
      start,
      { x: start.x, y: startStemY },
      ...interiorPoints,
      { x: end.x, y: endStemY },
      end
    ]);
    points = snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards);
    return points;
  }

  const sourceLeftOfTarget = sourceCenterX < targetCenterX;
  const start = {
    x: sourceLeftOfTarget ? connection.rectA.right : connection.rectA.left,
    y: sourceCenterY
  };
  const end = {
    x: sourceLeftOfTarget ? connection.rectB.left : connection.rectB.right,
    y: targetCenterY
  };

  const horizontalDistance = Math.abs(end.x - start.x);
  const stemLength = Math.min(16, Math.max(8, Math.floor(horizontalDistance / 4)));
  const startStemX = sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength;
  const endStemX = sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength;
  const interiorStart = { x: startStemX, y: start.y + connection.startLane * laneSeparation };
  const interiorEnd = { x: endStemX, y: end.y + connection.endLane * laneSeparation };
  const interiorPoints = createOrthogonalPolyline(interiorStart, interiorEnd, 0, false);
  let points = dedupeConsecutivePoints([
    start,
    { x: startStemX, y: start.y },
    ...interiorPoints,
    { x: endStemX, y: end.y },
    end
  ]);
  points = snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards);
  return points;
}

function routesShareTrack(pointsA, pointsB) {
  for (let indexA = 2; indexA < pointsA.length - 1; indexA += 1) {
    const startA = pointsA[indexA - 1];
    const endA = pointsA[indexA];
    const horizontalA = Math.abs(startA.y - endA.y) < 0.01;
    const verticalA = Math.abs(startA.x - endA.x) < 0.01;
    if (!horizontalA && !verticalA) continue;

    for (let indexB = 2; indexB < pointsB.length - 1; indexB += 1) {
      const startB = pointsB[indexB - 1];
      const endB = pointsB[indexB];
      const horizontalB = Math.abs(startB.y - endB.y) < 0.01;
      const verticalB = Math.abs(startB.x - endB.x) < 0.01;

      if (horizontalA && horizontalB && Math.abs(startA.y - startB.y) < MIN_PARALLEL_ROUTE_GAP) {
        const overlap = Math.min(Math.max(startA.x, endA.x), Math.max(startB.x, endB.x))
          - Math.max(Math.min(startA.x, endA.x), Math.min(startB.x, endB.x));
        if (overlap > 1) return true;
      }

      if (verticalA && verticalB && Math.abs(startA.x - startB.x) < MIN_PARALLEL_ROUTE_GAP) {
        const overlap = Math.min(Math.max(startA.y, endA.y), Math.max(startB.y, endB.y))
          - Math.max(Math.min(startA.y, endA.y), Math.min(startB.y, endB.y));
        if (overlap > 1) return true;
      }
    }
  }
  return false;
}

function buildParallelConnectionPaths(connections, cardRects, cards) {
  const accepted = [];
  const laneOrder = getPreferredLaneOrder(20);

  connections
    .slice()
    .sort((a, b) => Math.abs(a.routeLane || 0) - Math.abs(b.routeLane || 0)
      || a.scenarioA.id.localeCompare(b.scenarioA.id)
      || a.scenarioB.id.localeCompare(b.scenarioB.id))
    .forEach((connection) => {
      const candidateLanes = [...new Set([connection.routeLane || 0, ...laneOrder])];
      let selectedPoints = null;

      candidateLanes.some((lane) => {
        connection.routeLane = lane;
        const points = buildAvoidingOrthogonalPath(connection, cardRects, cards)
          || buildFallbackOrthogonalPath(connection, cardRects, cards);
        if (accepted.some((entry) => routesShareTrack(points, entry.points))) return false;
        selectedPoints = points;
        return true;
      });

      accepted.push({ connection, points: selectedPoints || buildFallbackOrthogonalPath(connection, cardRects, cards) });
    });

  return accepted;
}

function toSvgPathData(points) {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
}

function appendConnectionPathElements(hitSvg, visualSvg, d, connection) {
  const hitTarget = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  hitTarget.setAttribute('d', d);
  hitTarget.setAttribute('class', 'connection-hit-target');
  hitTarget.addEventListener('click', (event) => {
    event.stopPropagation();
    renderConnectionTooltip(event, connection);
  });
  hitTarget.addEventListener('mouseleave', hideConnectionTooltip);
  hitSvg.appendChild(hitTarget);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'connection-line strong');
  path.setAttribute('pointer-events', 'none');
  const connectionColor = getConnectionColor(connection);
  if (connectionColor) path.style.stroke = connectionColor;
  visualSvg.appendChild(path);
}

const ROUTE_CLEARANCE = 10;
const ROUTE_PARALLEL_GAP = 8;
const ROUTE_STEM_LENGTHS = [DETOUR_STEM_LENGTH];
const ROUTE_ALIGNMENT_TOLERANCE = 4;

function getRouteMiddleSegment(points) {
  if (!Array.isArray(points) || points.length < 4) return null;
  return { start: points[2], end: points[3] };
}

function getAxisValue(segment, preferVertical) {
  return preferVertical ? segment.start.x : segment.start.y;
}

function isAlignedConnection(connection) {
  return connection.preferVertical
    ? Math.abs(connection.rectA.cx - connection.rectB.cx) <= ROUTE_ALIGNMENT_TOLERANCE
    : Math.abs(connection.rectA.cy - connection.rectB.cy) <= ROUTE_ALIGNMENT_TOLERANCE;
}

function rangesOverlapWithGap(minA, maxA, minB, maxB, gap = 0) {
  return maxA >= minB - gap && maxB >= minA - gap;
}

function routeSegmentsConflict(first, second, gap = ROUTE_PARALLEL_GAP) {
  const firstHorizontal = Math.abs(first.start.y - first.end.y) < 0.01;
  const secondHorizontal = Math.abs(second.start.y - second.end.y) < 0.01;
  const firstVertical = Math.abs(first.start.x - first.end.x) < 0.01;
  const secondVertical = Math.abs(second.start.x - second.end.x) < 0.01;

  if (firstHorizontal && secondHorizontal) {
    return Math.abs(first.start.y - second.start.y) < gap
      && rangesOverlapWithGap(
        Math.min(first.start.x, first.end.x),
        Math.max(first.start.x, first.end.x),
        Math.min(second.start.x, second.end.x),
        Math.max(second.start.x, second.end.x),
        0
      );
  }

  if (firstVertical && secondVertical) {
    return Math.abs(first.start.x - second.start.x) < gap
      && rangesOverlapWithGap(
        Math.min(first.start.y, first.end.y),
        Math.max(first.start.y, first.end.y),
        Math.min(second.start.y, second.end.y),
        Math.max(second.start.y, second.end.y),
        0
      );
  }

  // Crossing perpendicular segments do not share a track. Only parallel
  // segments are reserved to keep the middle lines visually separated.
  return false;
}

function buildRouteAxisCandidates(connection, cardRects, reservedSegments) {
  const preferVertical = connection.preferVertical;
  const preferredAxis = preferVertical
    ? (connection.rectA.cx + connection.rectB.cx) / 2
    : (connection.rectA.cy + connection.rectB.cy) / 2;
  const candidates = [preferredAxis, 24];
  for (let step = 1; step <= 8; step += 1) {
    const offset = ROUTE_PARALLEL_GAP * step;
    candidates.push(preferredAxis - offset, preferredAxis + offset);
  }

  cardRects.forEach((rect) => {
    if (preferVertical) {
      candidates.push(rect.left - ROUTE_CLEARANCE, rect.right + ROUTE_CLEARANCE);
    } else {
      candidates.push(rect.top - ROUTE_CLEARANCE, rect.bottom + ROUTE_CLEARANCE);
    }
  });

  reservedSegments.forEach((reserved) => {
    const axis = getAxisValue(reserved.segment, preferVertical);
    candidates.push(axis - ROUTE_PARALLEL_GAP, axis + ROUTE_PARALLEL_GAP);
  });

  const maxAxis = preferVertical
    ? Math.max(...cardRects.map((rect) => rect.right), 0)
    : Math.max(...cardRects.map((rect) => rect.bottom), 0);
  const minAxis = preferVertical
    ? Math.min(...cardRects.map((rect) => rect.left), 0)
    : Math.min(...cardRects.map((rect) => rect.top), 0);
  candidates.push(minAxis - 64);
  candidates.push(maxAxis + 64);

  return uniqueSortedNumbers(candidates);
}

function buildRouteCandidate(connection, axisValue, stemLength) {
  const { rectA, rectB, preferVertical } = connection;
  const sourceAboveTarget = rectA.cy < rectB.cy;
  const sourceLeftOfTarget = rectA.cx < rectB.cx;

  if (preferVertical) {
    const start = { x: rectA.cx, y: sourceAboveTarget ? rectA.bottom : rectA.top };
    const end = { x: rectB.cx, y: sourceAboveTarget ? rectB.top : rectB.bottom };
    const startExit = { x: start.x, y: sourceAboveTarget ? start.y + stemLength : start.y - stemLength };
    const endExit = { x: end.x, y: sourceAboveTarget ? end.y - stemLength : end.y + stemLength };
    return [
      start,
      startExit,
      { x: axisValue, y: startExit.y },
      { x: axisValue, y: endExit.y },
      endExit,
      end
    ];
  }

  const start = { x: sourceLeftOfTarget ? rectA.right : rectA.left, y: rectA.cy };
  const end = { x: sourceLeftOfTarget ? rectB.left : rectB.right, y: rectB.cy };
  const startExit = { x: sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength, y: start.y };
  const endExit = { x: sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength, y: end.y };
  return [
    start,
    startExit,
    { x: startExit.x, y: axisValue },
    { x: endExit.x, y: axisValue },
    endExit,
    end
  ];
}

function scoreRoute(points, preferredAxis, preferVertical) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.abs(points[index - 1].x - points[index].x)
      + Math.abs(points[index - 1].y - points[index].y);
  }
  const branchDistance = preferVertical
    ? Math.abs((points[2]?.x ?? 0) - (points[1]?.x ?? 0))
    : Math.abs((points[2]?.y ?? 0) - (points[1]?.y ?? 0));
  const axis = preferVertical ? points[2]?.x : points[2]?.y;
  const totalRouteScore = length + Math.max(0, points.length - 2) * 8 + Math.abs(axis - preferredAxis) * 0.2;
  return branchDistance * 1000 + totalRouteScore;
}

function findBestRoute(connection, cardRects, cards, reservedSegments) {
  const protectedCards = new Set([connection.a, connection.b]);
  const cardEntries = cardRects.map((rect, index) => ({ rect, card: cards[index] }));
  const preferredAxis = connection.preferVertical
    ? (connection.rectA.cx + connection.rectB.cx) / 2
    : (connection.rectA.cy + connection.rectB.cy) / 2;
  const candidates = buildRouteAxisCandidates(connection, cardRects, reservedSegments);
  let best = null;

  if (isAlignedConnection(connection)) {
    const alignedRawPoints = buildRouteCandidate(
      connection,
      preferredAxis,
      DETOUR_STEM_LENGTH
    );
    const alignedPoints = simplifyOrthogonalPoints(alignedRawPoints);
    const alignedSegment = getRouteMiddleSegment(alignedRawPoints);
    const alignedIsClear = !routeIntersectsAnyCard(alignedPoints, cardEntries, protectedCards)
      && alignedSegment
      && !reservedSegments.some((reserved) => (
        isAlignedConnection(reserved.connection)
        && routeSegmentsConflict(alignedSegment, reserved.segment)
      ));

    if (alignedIsClear) {
      return { points: alignedPoints, middleSegment: alignedSegment, score: 0 };
    }
  }

  candidates.forEach((axisValue) => {
    ROUTE_STEM_LENGTHS.forEach((stemLength) => {
      const rawPoints = buildRouteCandidate(connection, axisValue, stemLength);
      const points = simplifyOrthogonalPoints(rawPoints);
      if (routeIntersectsAnyCard(points, cardEntries, protectedCards)) return;

      const middleSegment = getRouteMiddleSegment(rawPoints);
      if (!middleSegment || reservedSegments.some((reserved) => routeSegmentsConflict(
        middleSegment,
        reserved.segment
      ))) return;

      const score = scoreRoute(points, preferredAxis, connection.preferVertical);
      if (!best || score < best.score) {
        best = { points, middleSegment, score };
      }
    });
  });

  return best;
}

function routeConnectionsWithoutOverlap(connections, cardRects, cards) {
  const reservedSegments = [];
  const routed = [];

  connections
    .slice()
    .sort((a, b) => {
      const directnessA = a.preferVertical
        ? Math.abs(a.rectA.cx - a.rectB.cx)
        : Math.abs(a.rectA.cy - a.rectB.cy);
      const directnessB = b.preferVertical
        ? Math.abs(b.rectA.cx - b.rectB.cx)
        : Math.abs(b.rectA.cy - b.rectB.cy);
      if (Math.abs(directnessA - directnessB) > 0.01) {
        return directnessA - directnessB;
      }

      const distanceA = Math.abs(a.rectA.cx - a.rectB.cx) + Math.abs(a.rectA.cy - a.rectB.cy);
      const distanceB = Math.abs(b.rectA.cx - b.rectB.cx) + Math.abs(b.rectA.cy - b.rectB.cy);
      return distanceA - distanceB || a.scenarioA.id.localeCompare(b.scenarioA.id);
    })
    .forEach((connection) => {
      const fallbackStemLength = DETOUR_STEM_LENGTH;
      const best = findBestRoute(connection, cardRects, cards, reservedSegments)
        || { points: buildRouteCandidate(connection, connection.preferVertical
          ? (connection.rectA.cx + connection.rectB.cx) / 2
          : (connection.rectA.cy + connection.rectB.cy) / 2, fallbackStemLength) };
      const middleSegment = best.middleSegment || getRouteMiddleSegment(best.points);
      if (middleSegment) reservedSegments.push({ segment: middleSegment, connection });
      routed.push({ connection, points: best.points });
    });

  return routed;
}

function drawConnections(visibleScenarios = state.scenarios) {
  ensureConnectionTooltip();

  const zoomLayer = timelineEl.querySelector('.timeline-zoom-layer') || timelineEl;
  zoomLayer.querySelectorAll('.timeline-overlay').forEach((overlay) => overlay.remove());
  const visualSvg = createConnectionLayerSvg('timeline-overlay');
  const hitSvg = createConnectionLayerSvg('timeline-overlay hit-overlay');
  const overlayWidth = Math.max(zoomLayer.clientWidth, zoomLayer.scrollWidth);
  const overlayHeight = Math.max(zoomLayer.clientHeight, zoomLayer.scrollHeight);
  [visualSvg, hitSvg].forEach((svg) => {
    svg.style.width = `${overlayWidth}px`;
    svg.style.height = `${overlayHeight}px`;
    svg.setAttribute('viewBox', `0 0 ${overlayWidth} ${overlayHeight}`);
  });

  const cards = [...document.querySelectorAll('.scenario-card')];
  if (cards.length < 2) {
    zoomLayer.appendChild(visualSvg);
    zoomLayer.appendChild(hitSvg);
    return;
  }

  const timelineRect = zoomLayer.getBoundingClientRect();
  const cardRects = cards.map((card) => getRectFromCard(card, timelineRect));
  const visibleMap = new Map(visibleScenarios.map((scenario) => [scenario.id, scenario]));
  const positionedScenarios = cards
    .map((card, index) => {
      const scenario = visibleMap.get(card.dataset.scenarioId);
      if (!scenario) return null;
      return {
        card,
        scenario,
        rect: cardRects[index]
      };
    })
    .filter(Boolean);
  const validPairIds = getSharedParticipantPairIdsByVisualOrder(positionedScenarios);
  const connections = collectConnections(cards, visibleMap, timelineRect, validPairIds);

  routeConnectionsWithoutOverlap(connections, cardRects, cards).forEach(({ connection, points }) => {
    const optimizedPoints = simplifyOrthogonalPoints(points);
    const d = toSvgPathData(optimizedPoints);
    appendConnectionPathElements(hitSvg, visualSvg, d, connection);
  });

  zoomLayer.appendChild(visualSvg);
  zoomLayer.appendChild(hitSvg);
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.connection-line') && !event.target.closest('#connection-tooltip')) {
    hideConnectionTooltip();
  }
});

function clampTimelineZoom(value) {
  return Math.min(Math.max(value, timelineZoomState.min), timelineZoomState.max);
}

function updateTimelineZoom(nextScale) {
  if (!timelineEl) return;
  timelineZoomState.scale = clampTimelineZoom(nextScale);
  timelineEl.style.setProperty('--timeline-scale', String(timelineZoomState.scale));
}

function attachTimelineZoomHandlers() {
  if (!timelineEl) return;

  timelineEl.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.12 : -0.12;
    updateTimelineZoom(timelineZoomState.scale + delta);
  }, { passive: false });

  timelineEl.addEventListener('dblclick', (event) => {
    if (event.target.closest('.scenario-card')) return;
    updateTimelineZoom(1);
  });

  updateTimelineZoom(1);
}

function render() {
  refreshFilterOptions(applyFiltersAndRender);
  updateSearchStateFromFilters();
  syncSelectedScenarioToVisible();
  renderScenarioList();
  renderTimeline();
  renderDetailPanel();
  updateFilterStatus(getVisibleScenarios);
}

document.getElementById('add-scenario-btn').addEventListener('click', () => {
  openScenarioModal();
});

document.getElementById('manage-tags-btn').addEventListener('click', () => {
  openTagManagerModal();
});

attachTimelineZoomHandlers();

function loadScenariosFromJson(rawText) {
  try {
    const parsed = JSON.parse(String(rawText || '[]'));
    const payload = Array.isArray(parsed)
      ? { scenarios: parsed, tags: state.tags }
      : parsed && Array.isArray(parsed.scenarios)
        ? parsed
        : { scenarios: [], tags: state.tags };

    const normalizedTags = Array.isArray(payload.tags)
      ? payload.tags.map((tag, index) => normalizeTag(tag, index))
      : [...state.tags];
    const normalized = normalizeScenarios(payload.scenarios || []);

    state.tags = normalizedTags;
    state.scenarios = normalized;
    state.selectedScenarioId = normalized[0]?.id || null;
    render();
    return true;
  } catch (error) {
    console.error('JSON import failed', error);
    alert('JSONの読み込みに失敗しました。形式を確認してください。');
    return false;
  }
}

document.getElementById('json-export-btn').addEventListener('click', () => {
  const json = createJsonPayload(state.tags, state.scenarios);
  downloadFile('trpg_timeline_data.json', json, 'application/json;charset=utf-8');

  const reloaded = JSON.parse(json);
  const normalizedTags = Array.isArray(reloaded.tags)
    ? reloaded.tags.map((tag, index) => normalizeTag(tag, index))
    : [...state.tags];
  const parsedScenarios = normalizeScenarios(reloaded.scenarios || []);
  state.tags = normalizedTags;
  state.scenarios = parsedScenarios;
  state.selectedScenarioId = parsedScenarios[0]?.id || null;
  render();
});

document.getElementById('json-import-btn').addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      loadScenariosFromJson(String(reader.result || '[]'));
    };
    reader.readAsText(file);
  };
  input.click();
});

document.getElementById('export-btn').addEventListener('click', () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    tags: state.tags,
    scenarios: state.scenarios
  };
  const payloadJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  const timestamp = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const filename = `trpg_timeline_${timestamp.getFullYear()}${pad(timestamp.getMonth() + 1)}${pad(timestamp.getDate())}_${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}${pad(timestamp.getSeconds())}.html`;

  const html = `<!DOCTYPE html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>TRPG Timeline Export</title>
    <style>
      :root {
        --bg: #f3f5f9;
        --panel: #ffffff;
        --panel-border: #dce3f0;
        --text: #1f2a37;
        --muted: #6b7280;
        --line-strong: #4a4f58;
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        height: 100%;
        font-family: "Segoe UI", "Yu Gothic UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }

      .shell {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 320px;
        height: 100vh;
      }

      .main {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      .toolbar {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 12px 16px;
        background: rgba(255, 255, 255, 0.92);
        border-bottom: 1px solid var(--panel-border);
      }

      .toolbar-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .toolbar h1 {
        margin: 0;
        font-size: 1.02rem;
      }

      .search-wrap {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        width: min(860px, 100%);
      }

      .search-wrap input {
        flex: 1 1 320px;
        border: 1px solid var(--panel-border);
        border-radius: 10px;
        padding: 9px 10px;
        font: inherit;
        background: #fff;
        color: var(--text);
      }

      .search-wrap button {
        border: 1px solid var(--panel-border);
        border-radius: 8px;
        background: #fff;
        color: var(--text);
        padding: 8px 10px;
        font: inherit;
        cursor: pointer;
      }

      .search-wrap .status {
        margin-left: auto;
      }

      .filter-advanced {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        padding-top: 2px;
      }

      .filter-heading {
        grid-column: 1 / -1;
        font-size: 0.78rem;
        color: var(--muted);
        font-weight: 700;
      }

      .filter-advanced.hidden {
        display: none;
      }

      .filter-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.76rem;
        color: var(--muted);
      }

      .filter-field input,
      .filter-field select {
        width: 100%;
        border: 1px solid var(--panel-border);
        border-radius: 8px;
        padding: 7px 8px;
        font: inherit;
        color: var(--text);
        background: #fff;
      }

      .timeline {
        position: relative;
        flex: 1;
        overflow: auto;
        padding: 20px;
      }

      .timeline-canvas {
        position: relative;
      }

      .month-group {
        position: relative;
        margin-bottom: 24px;
      }

      .month-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 10px;
        font-weight: 700;
      }

      .month-divider {
        flex: 1;
        border-top: 2px dashed rgba(125, 145, 187, 0.9);
      }

      .timeline-layer {
        position: relative;
        margin-left: 80px;
        min-height: 150px;
      }

      .scenario-card {
        position: absolute;
        width: 200px;
        min-height: 90px;
        border: 1px solid #dfe7f5;
        border-radius: 16px;
        background: #f9fafb;
        padding: 12px;
        box-shadow: 0 8px 20px rgba(32, 45, 64, 0.08);
        cursor: pointer;
        z-index: 3;
      }

      .scenario-card.selected {
        border-color: #2d5df1;
        box-shadow: 0 0 0 3px rgba(45,93,241,0.14);
      }

      .scenario-tag-strip {
        height: 8px;
        border-radius: 999px;
        margin: -2px -2px 10px;
      }

      .scenario-title {
        font-size: 1rem;
        font-weight: 700;
        margin-bottom: 8px;
      }

      .scenario-summary {
        color: var(--muted);
        font-size: 0.82rem;
      }

      .timeline-overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2;
      }

      .timeline-overlay.hit-overlay {
        z-index: 5;
      }

      .connection-line {
        fill: none;
        stroke: var(--line-strong);
        stroke-width: 2.3;
        stroke-linecap: round;
        stroke-linejoin: round;
        pointer-events: none;
      }

      .connection-hit-target {
        fill: none;
        stroke: transparent;
        stroke-width: 12;
        pointer-events: stroke;
      }

      .detail {
        border-left: 1px solid var(--panel-border);
        background: var(--panel);
        overflow: auto;
      }

      .detail-header {
        padding: 16px 18px;
        border-bottom: 1px solid var(--panel-border);
        font-weight: 700;
      }

      .detail-body {
        padding: 16px;
      }

      .detail-card h3 {
        margin: 0 0 10px;
      }

      .meta-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 10px;
      }

      .tag {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--panel-border);
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 0.76rem;
        background: #fff;
      }

      .section-label {
        margin-top: 14px;
        margin-bottom: 6px;
        font-size: 0.82rem;
        font-weight: 700;
        color: var(--muted);
      }

      .detail-text {
        margin: 0;
        line-height: 1.58;
      }

      .empty {
        padding: 24px;
        color: var(--muted);
      }

      .status {
        font-size: 0.8rem;
        color: var(--muted);
      }

      .connection-tooltip {
        position: fixed;
        z-index: 20;
        min-width: 190px;
        max-width: 260px;
        padding: 10px 12px;
        border: 1px solid rgba(45, 93, 241, 0.2);
        border-radius: 12px;
        background: rgba(255,255,255,0.96);
        box-shadow: 0 10px 28px rgba(32, 45, 64, 0.12);
        font-size: 0.82rem;
        pointer-events: none;
      }

      .connection-tooltip.hidden { display: none; }

      @media (max-width: 980px) {
        .shell {
          grid-template-columns: 1fr;
          grid-template-rows: minmax(0, 1fr) 42vh;
        }
        .detail { border-left: none; border-top: 1px solid var(--panel-border); }
        .search-wrap { min-width: 0; }
        .filter-advanced { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <main class="main">
        <header class="toolbar">
          <div class="toolbar-row">
            <h1>TRPG Timeline Export</h1>
          </div>
          <div class="search-wrap">
            <input id="search-keyword" type="text" placeholder="検索: タイトル/サマリー/GM/PC/NPC/タグ" />
            <button id="toggle-advanced" type="button" aria-expanded="false">詳細検索</button>
            <button id="clear-search" type="button">解除</button>
            <span id="status" class="status"></span>
          </div>
          <div id="advanced-panel" class="filter-advanced hidden">
            <div class="filter-heading">詳細検索</div>
            <label class="filter-field"><span>タイトル</span><input id="filter-title" type="text" /></label>
            <label class="filter-field"><span>サマリー</span><input id="filter-summary" type="text" /></label>
            <label class="filter-field"><span>GM</span><input id="filter-gm" type="text" /></label>
            <label class="filter-field"><span>キャラクター</span><input id="filter-character" type="text" placeholder="PC/NPC" /></label>
            <label class="filter-field"><span>タグ(カンマ区切り)</span><input id="filter-tags" type="text" placeholder="メイン, 依頼" /></label>
            <label class="filter-field"><span>舞台(カンマ区切り)</span><input id="filter-stage-names" type="text" placeholder="N市, D市" /></label>
            <label class="filter-field"><span>チップ選択</span><div class="tag-chip-list filter-tag-chip-list" id="filter-stage-chips"></div></label>
            <label class="filter-field"><span>タグ条件</span><select id="filter-tag-mode"><option value="or">OR</option><option value="and">AND</option></select></label>
            <label class="filter-field"><span>年From</span><input id="filter-year-from" type="number" min="1" /></label>
            <label class="filter-field"><span>年To</span><input id="filter-year-to" type="number" min="1" /></label>
            <label class="filter-field"><span>月From</span><input id="filter-month-from" type="number" min="1" max="12" /></label>
            <label class="filter-field"><span>月To</span><input id="filter-month-to" type="number" min="1" max="12" /></label>
          </div>
        </header>
        <div id="timeline" class="timeline"></div>
      </main>
      <aside class="detail">
        <div class="detail-header">詳細</div>
        <div id="detail-panel" class="detail-body"></div>
      </aside>
    </div>

    <script id="export-data" type="application/json">${payloadJson}</script>
    <script>
      (() => {
        const dataNode = document.getElementById('export-data');
        const timelineEl = document.getElementById('timeline');
        const detailEl = document.getElementById('detail-panel');
        const searchInput = document.getElementById('search-keyword');
        const toggleAdvancedBtn = document.getElementById('toggle-advanced');
        const advancedPanel = document.getElementById('advanced-panel');
        const clearBtn = document.getElementById('clear-search');
        const statusEl = document.getElementById('status');
        const filterTitleEl = document.getElementById('filter-title');
        const filterSummaryEl = document.getElementById('filter-summary');
        const filterGmEl = document.getElementById('filter-gm');
        const filterCharacterEl = document.getElementById('filter-character');
        const filterTagsEl = document.getElementById('filter-tags');
        const filterStageNamesEl = document.getElementById('filter-stage-names');
        const filterStageChipsEl = document.getElementById('filter-stage-chips');
        const filterTagModeEl = document.getElementById('filter-tag-mode');
        const filterYearFromEl = document.getElementById('filter-year-from');
        const filterYearToEl = document.getElementById('filter-year-to');
        const filterMonthFromEl = document.getElementById('filter-month-from');
        const filterMonthToEl = document.getElementById('filter-month-to');

        function safeArray(value) {
          return Array.isArray(value) ? value.filter((item) => String(item || '').trim()) : [];
        }

        function parseCsv(value) {
          return String(value || '')
            .split(',')
            .map((item) => item.trim().toLowerCase())
            .filter(Boolean);
        }

        function parseOptionalNumber(value, min, max) {
          const num = Number(value);
          if (!Number.isFinite(num)) return null;
          if (num < min || num > max) return null;
          return num;
        }

        function normalizeScenario(raw, index) {
          const info = raw && typeof raw.information === 'object' && raw.information ? raw.information : {};
          const tagIdSources = [
            safeArray(raw && raw.tagIds),
            safeArray(raw && raw.tags).map((tag) => typeof tag === 'string' ? tag : (tag && tag.id) || '')
          ].flat();
          const placement = raw && raw.placement && raw.placement.referenceScenarioId && raw.placement.relation
            ? {
                referenceScenarioId: String(raw.placement.referenceScenarioId),
                relation: raw.placement.relation === 'same' ? 'same' : 'after'
              }
            : null;
          return {
            id: String(raw && raw.id ? raw.id : 's' + (index + 1)),
            year: Number(raw && raw.year) > 0 ? Number(raw.year) : 1,
            month: Number(raw && raw.month) >= 1 && Number(raw && raw.month) <= 12 ? Number(raw.month) : 1,
            xPriority: Number.isFinite(Number(raw && raw.xPriority)) ? Number(raw.xPriority) : 9999,
            title: String((raw && raw.title) || '無題シナリオ'),
            summary: String((raw && raw.summary) || ''),
            stage: String((raw && raw.stage) || ''),
            gm: String((raw && raw.gm) || ''),
            pcs: safeArray(raw && raw.pcs),
            npcs: safeArray(raw && raw.npcs),
            tagIds: [...new Set(tagIdSources.map(String).filter(Boolean))],
            information: {
              trailer: String(info.trailer || ''),
              description: String(info.description || '')
            },
            placement
          };
        }

        function normalizeTag(raw, index) {
          return {
            id: String(raw && raw.id ? raw.id : 'tag-' + (index + 1)),
            name: String((raw && raw.name) || 'タグ' + (index + 1)),
            color: /^#([0-9a-fA-F]{6})$/.test(String(raw && raw.color || '')) ? String(raw.color) : '#5b8cff'
          };
        }

        function escapeHtml(value) {
          return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function getMonthLabel(year, month) {
          return year + '年目 ' + month + '月';
        }

        function getMonthKey(s) {
          return String(s.year).padStart(3, '0') + '-' + String(s.month).padStart(2, '0');
        }

        function getScenarioTags(scenario, tags) {
          const byId = new Map(tags.map((tag) => [tag.id, tag]));
          return (scenario.tagIds || []).map((tagId) => byId.get(tagId)).filter(Boolean);
        }

        function getScenarioTagGradient(scenario, tags) {
          const scenarioTags = getScenarioTags(scenario, tags);
          if (!scenarioTags.length) return '';
          if (scenarioTags.length === 1) return scenarioTags[0].color;
          const step = 100 / scenarioTags.length;
          return 'linear-gradient(90deg,' + scenarioTags.map((tag, idx) => {
            const start = (idx * step).toFixed(2);
            const end = ((idx + 1) * step).toFixed(2);
            return tag.color + ' ' + start + '%, ' + tag.color + ' ' + end + '%';
          }).join(',') + ')';
        }

        function hasSameParticipantName(a, b) {
          const setA = new Set([...(a.pcs || []), ...(a.npcs || [])]);
          return [...(b.pcs || []), ...(b.npcs || [])].some((name) => setA.has(name));
        }

        function getSharedParticipants(a, b) {
          const setA = new Set([...(a.pcs || []), ...(a.npcs || [])]);
          return [...new Set([...(b.pcs || []), ...(b.npcs || [])].filter((name) => setA.has(name)))];
        }

        function getParticipants(scenario) {
          return [...(scenario && scenario.pcs ? scenario.pcs : []), ...(scenario && scenario.npcs ? scenario.npcs : [])];
        }

        function getRectFromCard(card, timelineRect) {
          const rect = card.getBoundingClientRect();
          return {
            left: rect.left - timelineRect.left,
            top: rect.top - timelineRect.top,
            right: rect.right - timelineRect.left,
            bottom: rect.bottom - timelineRect.top,
            width: rect.width,
            height: rect.height,
            cx: rect.left - timelineRect.left + rect.width / 2,
            cy: rect.top - timelineRect.top + rect.height / 2
          };
        }

        function getSharedParticipantPairIdsByVisualOrder(positionedScenarios) {
          const participantMap = new Map();
          positionedScenarios.forEach((item) => {
            const participants = [...new Set(getParticipants(item.scenario))];
            participants.forEach((participant) => {
              if (!participantMap.has(participant)) participantMap.set(participant, []);
              participantMap.get(participant).push(item);
            });
          });

          const pairIds = new Set();
          participantMap.forEach((scenariosForParticipant) => {
            const uniqueScenarios = [...new Map(
              scenariosForParticipant.map((item) => [item.scenario.id, item])
            ).values()].sort((a, b) => {
              const yDiff = a.rect.cy - b.rect.cy;
              if (Math.abs(yDiff) > 0.01) return yDiff;
              const xDiff = a.rect.cx - b.rect.cx;
              if (Math.abs(xDiff) > 0.01) return xDiff;
              return a.scenario.title.localeCompare(b.scenario.title);
            });

            for (let index = 1; index < uniqueScenarios.length; index += 1) {
              const previous = uniqueScenarios[index - 1];
              const current = uniqueScenarios[index];
              pairIds.add([previous.scenario.id, current.scenario.id].sort().join(':'));
            }
          });

          return pairIds;
        }

        function rectIntersectsSegment(rect, p1, p2) {
          const padding = 18;
          const minX = Math.min(p1.x, p2.x) - padding;
          const maxX = Math.max(p1.x, p2.x) + padding;
          const minY = Math.min(p1.y, p2.y) - padding;
          const maxY = Math.max(p1.y, p2.y) + padding;
          const inflatedRect = {
            left: rect.left - padding,
            top: rect.top - padding,
            right: rect.right + padding,
            bottom: rect.bottom + padding
          };
          return !(maxX < inflatedRect.left || minX > inflatedRect.right || maxY < inflatedRect.top || minY > inflatedRect.bottom);
        }

        function inflateRect(rect, padding) {
          return {
            left: rect.left - padding,
            top: rect.top - padding,
            right: rect.right + padding,
            bottom: rect.bottom + padding
          };
        }

        function segmentIntersectsInflatedRect(p1, p2, rect, padding) {
          const inflated = inflateRect(rect, padding == null ? 12 : padding);
          const minX = Math.min(p1.x, p2.x);
          const maxX = Math.max(p1.x, p2.x);
          const minY = Math.min(p1.y, p2.y);
          const maxY = Math.max(p1.y, p2.y);

          if (Math.abs(p1.x - p2.x) < 0.01) {
            return p1.x >= inflated.left && p1.x <= inflated.right && maxY >= inflated.top && minY <= inflated.bottom;
          }
          if (Math.abs(p1.y - p2.y) < 0.01) {
            return p1.y >= inflated.top && p1.y <= inflated.bottom && maxX >= inflated.left && minX <= inflated.right;
          }
          return rectIntersectsSegment(inflated, p1, p2);
        }

        function routeIntersectsAnyCard(points, cardEntries, protectedCards) {
          for (let index = 0; index < points.length - 1; index += 1) {
            const start = points[index];
            const end = points[index + 1];
            for (let cardIndex = 0; cardIndex < cardEntries.length; cardIndex += 1) {
              const cardEntry = cardEntries[cardIndex];
              if (protectedCards.has(cardEntry.card)) continue;
              if (segmentIntersectsInflatedRect(start, end, cardEntry.rect, 8)) {
                return true;
              }
            }
          }
          return false;
        }

        function uniqueSortedNumbers(values) {
          return [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
        }

        function buildAxisCandidates(intervals, preferred, fallbackMin, fallbackMax, gapPadding) {
          const candidates = [preferred, fallbackMin, fallbackMax];
          const actualGapPadding = gapPadding == null ? 16 : gapPadding;
          if (!intervals.length) return uniqueSortedNumbers(candidates);

          const sorted = intervals.slice().sort((a, b) => a.left - b.left);
          candidates.push(sorted[0].left - actualGapPadding, sorted[sorted.length - 1].right + actualGapPadding);

          for (let index = 0; index < sorted.length - 1; index += 1) {
            const current = sorted[index];
            const next = sorted[index + 1];
            if (next.left - current.right >= actualGapPadding * 2) {
              candidates.push((current.right + next.left) / 2);
            }
          }
          return uniqueSortedNumbers(candidates);
        }

        function scoreOrthogonalRoute(points, preferredAxisValue) {
          let length = 0;
          for (let index = 0; index < points.length - 1; index += 1) {
            length += Math.abs(points[index].x - points[index + 1].x) + Math.abs(points[index].y - points[index + 1].y);
          }
          const bendPenalty = Math.max(0, points.length - 2) * 12;
          const axisPenalty = preferredAxisValue == null ? 0 : Math.abs((points[1] ? points[1].x : preferredAxisValue) - preferredAxisValue);
          return length + bendPenalty + axisPenalty;
        }

        function dedupeConsecutivePoints(points) {
          if (!Array.isArray(points) || points.length === 0) return [];
          const result = [points[0]];
          for (let index = 1; index < points.length; index += 1) {
            const prev = result[result.length - 1];
            const current = points[index];
            if (Math.abs(prev.x - current.x) < 0.01 && Math.abs(prev.y - current.y) < 0.01) continue;
            result.push(current);
          }
          return result;
        }

        function simplifyOrthogonalPoints(points) {
          if (!Array.isArray(points) || points.length <= 2) return points || [];
          const epsilon = 0.01;
          const deduped = dedupeConsecutivePoints(points);
          if (deduped.length <= 2) return deduped;
          const simplified = [deduped[0]];
          for (let index = 1; index < deduped.length - 1; index += 1) {
            const prev = simplified[simplified.length - 1];
            const current = deduped[index];
            const next = deduped[index + 1];
            const sameX = Math.abs(prev.x - current.x) < epsilon && Math.abs(current.x - next.x) < epsilon;
            const sameY = Math.abs(prev.y - current.y) < epsilon && Math.abs(current.y - next.y) < epsilon;
            if (sameX || sameY) continue;
            simplified.push(current);
          }
          simplified.push(deduped[deduped.length - 1]);
          return dedupeConsecutivePoints(simplified);
        }

        const DETOUR_LANE_SPACING = 12;
        const MIN_PARALLEL_ROUTE_GAP = 12;
        const DETOUR_STEM_LENGTH = 8;

        function rangesOverlap(minA, maxA, minB, maxB, margin = 0) {
          return maxA >= minB - margin && maxB >= minA - margin;
        }

        function getPreferredDetourAxisAndSpan(connection) {
          const sourceAboveTarget = connection.rectA.cy < connection.rectB.cy;
          const sourceLeftOfTarget = connection.rectA.cx < connection.rectB.cx;

          if (connection.preferVertical) {
            const startY = sourceAboveTarget
              ? connection.rectA.bottom + DETOUR_STEM_LENGTH
              : connection.rectA.top - DETOUR_STEM_LENGTH;
            const endY = sourceAboveTarget
              ? connection.rectB.top - DETOUR_STEM_LENGTH
              : connection.rectB.bottom + DETOUR_STEM_LENGTH;
            return {
              axis: (connection.rectA.cx + connection.rectB.cx) / 2,
              spanMin: Math.min(startY, endY),
              spanMax: Math.max(startY, endY)
            };
          }

          const startX = sourceLeftOfTarget
            ? connection.rectA.right + DETOUR_STEM_LENGTH
            : connection.rectA.left - DETOUR_STEM_LENGTH;
          const endX = sourceLeftOfTarget
            ? connection.rectB.left - DETOUR_STEM_LENGTH
            : connection.rectB.right + DETOUR_STEM_LENGTH;
          return {
            axis: (connection.rectA.cy + connection.rectB.cy) / 2,
            spanMin: Math.min(startX, endX),
            spanMax: Math.max(startX, endX)
          };
        }

        function getPreferredLaneOrder(limit = 16) {
          const order = [0];
          for (let index = 1; index <= limit; index += 1) {
            order.push(index, -index);
          }
          return order;
        }

        function assignConnectionDetourLanes(connections) {
          const vertical = [];
          const horizontal = [];

          connections.forEach((connection) => {
            const meta = getPreferredDetourAxisAndSpan(connection);
            connection.routeLane = 0;
            connection.routeMeta = meta;
            if (connection.preferVertical) {
              vertical.push(connection);
            } else {
              horizontal.push(connection);
            }
          });

          const laneOrder = getPreferredLaneOrder(20);

          function assignByOverlap(group) {
            const assigned = [];
            group
              .slice()
              .sort((a, b) => {
                const axisDiff = a.routeMeta.axis - b.routeMeta.axis;
                if (Math.abs(axisDiff) > 0.01) return axisDiff;
                const spanDiff = a.routeMeta.spanMin - b.routeMeta.spanMin;
                if (Math.abs(spanDiff) > 0.01) return spanDiff;
                return a.scenarioA.id.localeCompare(b.scenarioA.id) || a.scenarioB.id.localeCompare(b.scenarioB.id);
              })
              .forEach((connection) => {
                const overlapping = assigned.filter((other) => rangesOverlap(
                  connection.routeMeta.spanMin,
                  connection.routeMeta.spanMax,
                  other.routeMeta.spanMin,
                  other.routeMeta.spanMax,
                  2
                ));

                let chosenLane = 0;
                for (let index = 0; index < laneOrder.length; index += 1) {
                  const candidateLane = laneOrder[index];
                  const candidateAxis = connection.routeMeta.axis + candidateLane * DETOUR_LANE_SPACING;
                  const hasConflict = overlapping.some((other) => {
                    const otherAxis = other.routeMeta.axis + other.routeLane * DETOUR_LANE_SPACING;
                    return Math.abs(candidateAxis - otherAxis) < MIN_PARALLEL_ROUTE_GAP;
                  });
                  if (!hasConflict) {
                    chosenLane = candidateLane;
                    break;
                  }
                }

                connection.routeLane = chosenLane;
                assigned.push(connection);
              });
          }

          assignByOverlap(vertical);
          assignByOverlap(horizontal);
        }

        function buildAvoidingOrthogonalPath(connection, cardRects, cards) {
          const protectedCards = new Set([connection.a, connection.b]);
          const sourceRect = connection.rectA;
          const targetRect = connection.rectB;
          const sourceCenterX = sourceRect.cx;
          const sourceCenterY = sourceRect.cy;
          const targetCenterX = targetRect.cx;
          const targetCenterY = targetRect.cy;

          const preferVertical = connection.preferVertical;
          const stemLength = DETOUR_STEM_LENGTH;
          const detourOffset = (connection.routeLane || 0) * DETOUR_LANE_SPACING;

          const buildVertical = (bridgeX) => {
            const sourceAboveTarget = sourceCenterY < targetCenterY;
            const start = {
              x: sourceCenterX,
              y: sourceAboveTarget ? sourceRect.bottom : sourceRect.top
            };
            const end = {
              x: targetCenterX,
              y: sourceAboveTarget ? targetRect.top : targetRect.bottom
            };
            const startExit = {
              x: start.x,
              y: sourceAboveTarget ? start.y + stemLength : start.y - stemLength
            };
            const endExit = {
              x: end.x,
              y: sourceAboveTarget ? end.y - stemLength : end.y + stemLength
            };

            return [
              start,
              startExit,
              { x: bridgeX + detourOffset, y: startExit.y },
              { x: bridgeX + detourOffset, y: endExit.y },
              endExit,
              end
            ];
          };

          const buildHorizontal = (bridgeY) => {
            const sourceLeftOfTarget = sourceCenterX < targetCenterX;
            const start = {
              x: sourceLeftOfTarget ? sourceRect.right : sourceRect.left,
              y: sourceCenterY
            };
            const end = {
              x: sourceLeftOfTarget ? targetRect.left : targetRect.right,
              y: targetCenterY
            };
            const startExit = {
              x: sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength,
              y: start.y
            };
            const endExit = {
              x: sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength,
              y: end.y
            };

            return [
              start,
              startExit,
              { x: startExit.x, y: bridgeY + detourOffset },
              { x: endExit.x, y: bridgeY + detourOffset },
              endExit,
              end
            ];
          };

          const cardEntries = cardRects.map((rect, index) => ({ rect, card: cards[index] }));
          const otherRects = cardEntries.filter((entry) => !protectedCards.has(entry.card));
          const evaluateCandidates = (builder, axisCandidates, preferredAxisValue) => {
            let best = null;
            axisCandidates.forEach((axisValue) => {
              const points = simplifyOrthogonalPoints(builder(axisValue));
              if (routeIntersectsAnyCard(points, cardEntries, protectedCards)) {
                return;
              }

              const score = scoreOrthogonalRoute(points, preferredAxisValue);
              if (!best || score < best.score) {
                best = { points, score };
              }
            });
            return best?.points || null;
          };

          const buildPreferredNoDetourPath = () => {
            if (preferVertical) {
              const sourceAboveTarget = sourceCenterY < targetCenterY;
              const start = {
                x: sourceCenterX,
                y: sourceAboveTarget ? sourceRect.bottom : sourceRect.top
              };
              const end = {
                x: targetCenterX,
                y: sourceAboveTarget ? targetRect.top : targetRect.bottom
              };
              const startExit = {
                x: start.x,
                y: sourceAboveTarget ? start.y + stemLength : start.y - stemLength
              };
              const endExit = {
                x: end.x,
                y: sourceAboveTarget ? end.y - stemLength : end.y + stemLength
              };
              const bridgeX = (sourceCenterX + targetCenterX) / 2;
              return simplifyOrthogonalPoints([
                start,
                startExit,
                { x: bridgeX + detourOffset, y: startExit.y },
                { x: bridgeX + detourOffset, y: endExit.y },
                endExit,
                end
              ]);
            }

            const sourceLeftOfTarget = sourceCenterX < targetCenterX;
            const start = {
              x: sourceLeftOfTarget ? sourceRect.right : sourceRect.left,
              y: sourceCenterY
            };
            const end = {
              x: sourceLeftOfTarget ? targetRect.left : targetRect.right,
              y: targetCenterY
            };
            const startExit = {
              x: sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength,
              y: start.y
            };
            const endExit = {
              x: sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength,
              y: end.y
            };
            const bridgeY = (sourceCenterY + targetCenterY) / 2;
            return simplifyOrthogonalPoints([
              start,
              startExit,
              { x: startExit.x, y: bridgeY + detourOffset },
              { x: endExit.x, y: bridgeY + detourOffset },
              endExit,
              end
            ]);
          };

          if (preferVertical) {
            const sourceAboveTarget = sourceCenterY < targetCenterY;
            const start = sourceAboveTarget ? sourceRect.bottom : sourceRect.top;
            const end = sourceAboveTarget ? targetRect.top : targetRect.bottom;
            const minY = Math.min(start, end) - stemLength - 6;
            const maxY = Math.max(start, end) + stemLength + 6;
            const blockingRects = otherRects.filter((entry) => entry.rect.bottom >= minY && entry.rect.top <= maxY);
            const intervals = blockingRects.map((entry) => inflateRect(entry.rect, 10));
            const preferred = (sourceCenterX + targetCenterX) / 2;
            const axisCandidates = buildAxisCandidates(intervals, preferred, 24, Math.max(24, Math.max(...cardRects.map((rect) => rect.right), 0) + 64));
            const bestVertical = evaluateCandidates(buildVertical, axisCandidates, preferred);
            if (bestVertical) return bestVertical;
            return null;
          }

          {
            const sourceLeftOfTarget = sourceCenterX < targetCenterX;
            const start = sourceLeftOfTarget ? sourceRect.right : sourceRect.left;
            const end = sourceLeftOfTarget ? targetRect.left : targetRect.right;
            const minX = Math.min(start, end) - stemLength - 6;
            const maxX = Math.max(start, end) + stemLength + 6;
            const blockingRects = otherRects.filter((entry) => entry.rect.right >= minX && entry.rect.left <= maxX);
            const intervals = blockingRects.map((entry) => inflateRect(entry.rect, 10));
            const preferred = (sourceCenterY + targetCenterY) / 2;
            const axisCandidates = buildAxisCandidates(intervals, preferred, 24, Math.max(24, Math.max(...cardRects.map((rect) => rect.bottom), 0) + 64));
            const bestHorizontal = evaluateCandidates(buildHorizontal, axisCandidates, preferred);
            if (bestHorizontal) return bestHorizontal;
          }

          return null;
        }

        function createOrthogonalPolyline(start, end, laneBias, preferVertical) {
          if (preferVertical) {
            const x1 = start.x + laneBias;
            const x2 = end.x + laneBias;
            const midY = (start.y + end.y) / 2;

            return [
              { x: x1, y: start.y },
              { x: x1, y: midY },
              { x: x2, y: midY },
              { x: x2, y: end.y }
            ];
          }

          const y1 = start.y + laneBias;
          const y2 = end.y + laneBias;
          const midX = (start.x + end.x) / 2;

          return [
            { x: start.x, y: y1 },
            { x: midX, y: y1 },
            { x: midX, y: y2 },
            { x: end.x, y: y2 }
          ];
        }

        function getCenteredLaneIndex(index, total) {
          return index - (total - 1) / 2;
        }

        function assignConnectionLanesPerCardEdge(connections) {
          const edgeMap = new Map();

          connections.forEach((connection) => {
            const startKey = connection.scenarioA.id + ':' + connection.startEdge;
            const endKey = connection.scenarioB.id + ':' + connection.endEdge;

            if (!edgeMap.has(startKey)) edgeMap.set(startKey, []);
            if (!edgeMap.has(endKey)) edgeMap.set(endKey, []);

            edgeMap.get(startKey).push({ connection, side: 'start' });
            edgeMap.get(endKey).push({ connection, side: 'end' });
          });

          edgeMap.forEach((entries) => {
            entries.sort((a, b) => {
              const aCoord = a.side === 'start'
                ? (a.connection.preferVertical ? a.connection.rectB.cx : a.connection.rectB.cy)
                : (a.connection.preferVertical ? a.connection.rectA.cx : a.connection.rectA.cy);
              const bCoord = b.side === 'start'
                ? (b.connection.preferVertical ? b.connection.rectB.cx : b.connection.rectB.cy)
                : (b.connection.preferVertical ? b.connection.rectA.cx : b.connection.rectA.cy);
              return aCoord - bCoord;
            });

            const total = entries.length;
            entries.forEach((entry, index) => {
              const lane = getCenteredLaneIndex(index, total);
              if (entry.side === 'start') {
                entry.connection.startLane = lane;
              } else {
                entry.connection.endLane = lane;
              }
            });
          });
        }

        function snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards) {
          const protectedCards = new Set([connection.a, connection.b]);
          const snapped = points.map((point) => ({ x: point.x, y: point.y }));

          for (let i = 0; i < snapped.length - 1; i += 1) {
            const a = snapped[i];
            const b = snapped[i + 1];
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const nearStart = Math.hypot(mid.x - start.x, mid.y - start.y) < 28;
            const nearEnd = Math.hypot(mid.x - end.x, mid.y - end.y) < 28;
            if (nearStart || nearEnd) continue;

            if (Math.abs(a.y - b.y) < 0.5) {
              const horizontalY = a.y;
              for (let index = 0; index < cardRects.length; index += 1) {
                const card = cards[index];
                if (protectedCards.has(card)) continue;
                const rect = cardRects[index];
                const isNearTop = Math.abs(horizontalY - rect.top) < 12;
                const isNearBottom = Math.abs(horizontalY - rect.bottom) < 12;
                if (!isNearTop && !isNearBottom) continue;
                const minX = Math.min(a.x, b.x);
                const maxX = Math.max(a.x, b.x);
                const overlapsHorizontally = maxX >= rect.left - 6 && minX <= rect.right + 6;
                if (!overlapsHorizontally) continue;
                const edgeY = isNearTop ? rect.top : rect.bottom;
                const outsideOffset = isNearTop ? -8 : 8;
                a.y = edgeY + outsideOffset;
                b.y = edgeY + outsideOffset;
              }
            }

            if (Math.abs(a.x - b.x) < 0.5) {
              const verticalX = a.x;
              for (let index = 0; index < cardRects.length; index += 1) {
                const card = cards[index];
                if (protectedCards.has(card)) continue;
                const rect = cardRects[index];
                const isNearLeft = Math.abs(verticalX - rect.left) < 12;
                const isNearRight = Math.abs(verticalX - rect.right) < 12;
                if (!isNearLeft && !isNearRight) continue;
                const minY = Math.min(a.y, b.y);
                const maxY = Math.max(a.y, b.y);
                const overlapsVertically = maxY >= rect.top - 6 && minY <= rect.bottom + 6;
                if (!overlapsVertically) continue;
                const edgeX = isNearLeft ? rect.left : rect.right;
                const outsideOffset = isNearLeft ? -8 : 8;
                a.x = edgeX + outsideOffset;
                b.x = edgeX + outsideOffset;
              }
            }
          }

          return snapped;
        }

        function createConnectionLayerSvg(className) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', className);
          svg.setAttribute('aria-hidden', 'true');
          return svg;
        }

        function collectConnections(cards, visibleMap, timelineRect, validPairIds) {
          const connections = [];
          for (let i = 0; i < cards.length; i += 1) {
            for (let j = i + 1; j < cards.length; j += 1) {
              const a = cards[i];
              const b = cards[j];
              const scenarioA = visibleMap.get(a.dataset.scenarioId);
              const scenarioB = visibleMap.get(b.dataset.scenarioId);
              if (!scenarioA || !scenarioB) continue;
              if (!hasSameParticipantName(scenarioA, scenarioB)) continue;
              const pairKey = [scenarioA.id, scenarioB.id].sort().join(':');
              if (!validPairIds.has(pairKey)) continue;

              const rectA = getRectFromCard(a, timelineRect);
              const rectB = getRectFromCard(b, timelineRect);
              const sameRelation = scenarioA.placement && scenarioA.placement.relation === 'same'
                && scenarioA.placement.referenceScenarioId === scenarioB.id
                || scenarioB.placement && scenarioB.placement.relation === 'same'
                && scenarioB.placement.referenceScenarioId === scenarioA.id;
              const preferVertical = !sameRelation;
              const sourceAboveTarget = rectA.cy < rectB.cy;
              const sourceLeftOfTarget = rectA.cx < rectB.cx;

              connections.push({
                a,
                b,
                rectA,
                rectB,
                preferVertical,
                sourceAboveTarget,
                sourceLeftOfTarget,
                startEdge: preferVertical ? (sourceAboveTarget ? 'bottom' : 'top') : (sourceLeftOfTarget ? 'right' : 'left'),
                endEdge: preferVertical ? (sourceAboveTarget ? 'top' : 'bottom') : (sourceLeftOfTarget ? 'left' : 'right'),
                startLane: 0,
                endLane: 0,
                scenarioA,
                scenarioB
              });
            }
          }
          return connections;
        }

        function buildFallbackOrthogonalPath(connection, cardRects, cards) {
          const sourceCenterX = connection.rectA.cx;
          const sourceCenterY = connection.rectA.cy;
          const targetCenterX = connection.rectB.cx;
          const targetCenterY = connection.rectB.cy;
          const laneSeparation = 18;

          if (connection.preferVertical) {
            const sourceAboveTarget = sourceCenterY < targetCenterY;
            const start = { x: sourceCenterX, y: sourceAboveTarget ? connection.rectA.bottom : connection.rectA.top };
            const end = { x: targetCenterX, y: sourceAboveTarget ? connection.rectB.top : connection.rectB.bottom };
            const verticalDistance = Math.abs(end.y - start.y);
            const stemLength = Math.min(16, Math.max(8, Math.floor(verticalDistance / 4)));
            const startStemY = sourceAboveTarget ? start.y + stemLength : start.y - stemLength;
            const endStemY = sourceAboveTarget ? end.y - stemLength : end.y + stemLength;
            const interiorStart = { x: start.x + connection.startLane * laneSeparation, y: startStemY };
            const interiorEnd = { x: end.x + connection.endLane * laneSeparation, y: endStemY };
            const interiorPoints = createOrthogonalPolyline(interiorStart, interiorEnd, 0, true);
            let points = dedupeConsecutivePoints([start, { x: start.x, y: startStemY }, ...interiorPoints, { x: end.x, y: endStemY }, end]);
            points = snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards);
            return points;
          }

          const sourceLeftOfTarget = sourceCenterX < targetCenterX;
          const start = { x: sourceLeftOfTarget ? connection.rectA.right : connection.rectA.left, y: sourceCenterY };
          const end = { x: sourceLeftOfTarget ? connection.rectB.left : connection.rectB.right, y: targetCenterY };
          const horizontalDistance = Math.abs(end.x - start.x);
          const stemLength = Math.min(16, Math.max(8, Math.floor(horizontalDistance / 4)));
          const startStemX = sourceLeftOfTarget ? start.x + stemLength : start.x - stemLength;
          const endStemX = sourceLeftOfTarget ? end.x - stemLength : end.x + stemLength;
          const interiorStart = { x: startStemX, y: start.y + connection.startLane * laneSeparation };
          const interiorEnd = { x: endStemX, y: end.y + connection.endLane * laneSeparation };
          const interiorPoints = createOrthogonalPolyline(interiorStart, interiorEnd, 0, false);
          let points = dedupeConsecutivePoints([start, { x: startStemX, y: start.y }, ...interiorPoints, { x: endStemX, y: end.y }, end]);
          points = snapInteriorSegmentsToCardEdges(points, start, end, connection, cardRects, cards);
          return points;
        }

        function toSvgPathData(points) {
          return points.map((point, index) => (index === 0 ? 'M' : 'L') + ' ' + point.x + ' ' + point.y).join(' ');
        }

        function ensureConnectionTooltip() {
          let tooltip = document.getElementById('connection-tooltip');
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'connection-tooltip';
            tooltip.className = 'connection-tooltip hidden';
            timelineEl.appendChild(tooltip);
          }
          return tooltip;
        }

        function hideConnectionTooltip() {
          const tooltip = document.getElementById('connection-tooltip');
          if (tooltip) tooltip.classList.add('hidden');
        }

        function hideTooltip() {
          hideConnectionTooltip();
        }

        window.hideTooltip = hideTooltip;
        window.hideConnectionTooltip = hideConnectionTooltip;

        function renderConnectionTooltip(event, connection) {
          const tooltip = ensureConnectionTooltip();
          const scenarioA = connection.scenarioA;
          const scenarioB = connection.scenarioB;
          const sharedNames = new Set(getSharedParticipants(scenarioA, scenarioB));
          const formatCategory = (items) => (items || []).filter((item) => sharedNames.has(item));
          const buildSection = (label, items) => items.length ? '<div class="connection-tooltip-section">' + label + '：' + escapeHtml(items.join('、')) + '</div>' : '';

          tooltip.innerHTML = ''
            + '<div class="connection-tooltip-title">' + escapeHtml(scenarioA.title) + '</div>'
            + buildSection('PC', formatCategory(scenarioA.pcs || []))
            + buildSection('NPC', formatCategory(scenarioA.npcs || []))
            + '<div class="connection-tooltip-title" style="margin-top:8px;">' + escapeHtml(scenarioB.title) + '</div>'
            + buildSection('PC', formatCategory(scenarioB.pcs || []))
            + buildSection('NPC', formatCategory(scenarioB.npcs || []));

          tooltip.classList.remove('hidden');
          const maxLeft = Math.max(12, window.innerWidth - tooltip.offsetWidth - 12);
          const maxTop = Math.max(12, window.innerHeight - tooltip.offsetHeight - 12);
          tooltip.style.left = Math.min(event.clientX + 14, maxLeft) + 'px';
          tooltip.style.top = Math.min(event.clientY + 18, maxTop) + 'px';
        }

        function appendConnectionPathElements(hitSvg, visualSvg, d, connection) {
          const hitTarget = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hitTarget.setAttribute('d', d);
          hitTarget.setAttribute('class', 'connection-hit-target');
          hitTarget.addEventListener('click', (event) => {
            event.stopPropagation();
            renderConnectionTooltip(event, connection);
          });
          hitTarget.addEventListener('mouseleave', hideConnectionTooltip);
          hitSvg.appendChild(hitTarget);

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('class', 'connection-line');
          path.setAttribute('pointer-events', 'none');
          const exportTags = window.__exportTags || [];
          const sourceTags = getScenarioTags(connection.scenarioA, exportTags);
          const targetTags = getScenarioTags(connection.scenarioB, exportTags);
          if (sourceTags.length && targetTags.length) {
            path.style.stroke = sourceTags[0].color;
          }
          visualSvg.appendChild(path);
        }

        function drawConnections(visibleScenarios) {
          ensureConnectionTooltip();
          const old = timelineEl.querySelectorAll('.timeline-overlay');
          old.forEach((node) => node.remove());

          const visualSvg = createConnectionLayerSvg('timeline-overlay');
          const hitSvg = createConnectionLayerSvg('timeline-overlay hit-overlay');
          const overlayWidth = Math.max(timelineEl.clientWidth, timelineEl.scrollWidth);
          const overlayHeight = Math.max(timelineEl.clientHeight, timelineEl.scrollHeight);
          [visualSvg, hitSvg].forEach((svg) => {
            svg.style.width = overlayWidth + 'px';
            svg.style.height = overlayHeight + 'px';
            svg.setAttribute('viewBox', '0 0 ' + overlayWidth + ' ' + overlayHeight);
          });
          const cards = [...timelineEl.querySelectorAll('.scenario-card')];
          if (cards.length < 2) {
            timelineEl.appendChild(visualSvg);
            timelineEl.appendChild(hitSvg);
            return;
          }

          const timelineRect = timelineEl.getBoundingClientRect();
          const cardRects = cards.map((card) => getRectFromCard(card, timelineRect));
          const visibleMap = new Map(visibleScenarios.map((scenario) => [scenario.id, scenario]));
          const positionedScenarios = cards.map((card, index) => {
            const scenario = visibleMap.get(card.dataset.scenarioId);
            if (!scenario) return null;
            return { card, scenario, rect: cardRects[index] };
          }).filter(Boolean);

          const validPairIds = getSharedParticipantPairIdsByVisualOrder(positionedScenarios);
          const connections = collectConnections(cards, visibleMap, timelineRect, validPairIds);
          assignConnectionLanesPerCardEdge(connections);
          assignConnectionDetourLanes(connections);

          connections.forEach((connection) => {
            const points = buildAvoidingOrthogonalPath(connection, cardRects, cards)
              || buildFallbackOrthogonalPath(connection, cardRects, cards);
            const optimizedPoints = simplifyOrthogonalPoints(points);
            const d = toSvgPathData(optimizedPoints);
            appendConnectionPathElements(hitSvg, visualSvg, d, connection);
          });

          timelineEl.appendChild(visualSvg);
          timelineEl.appendChild(hitSvg);
        }

        function getPlacementSummary(scenario, byId) {
          if (!scenario.placement) return '未設定';
          const reference = byId.get(scenario.placement.referenceScenarioId);
          const referenceTitle = reference ? reference.title : '未参照';
          if (scenario.placement.relation === 'same') return 'same : ' + referenceTitle + 'と同じ';
          if (scenario.placement.relation === 'after') return 'after : ' + referenceTitle + 'の後';
          return scenario.placement.relation + ' : ' + referenceTitle;
        }

        function renderDetail(selected, tags, byId) {
          if (!selected) {
            detailEl.innerHTML = '<div class="empty">表示可能なシナリオがありません</div>';
            return;
          }

          const tagMarkup = getScenarioTags(selected, tags)
            .map((tag) => '<span class="tag" style="background:' + escapeHtml(tag.color) + ';color:white;border-color:transparent;">' + escapeHtml(tag.name) + '</span>')
            .join('') || '<span class="tag">なし</span>';

          detailEl.innerHTML = ''
            + '<div class="detail-card">'
            + '<h3>' + escapeHtml(selected.title) + '</h3>'
            + '<div class="meta-row">'
            + '<span class="tag">' + escapeHtml(getMonthLabel(selected.year, selected.month)) + '</span>'
            + '<span class="tag">' + escapeHtml(selected.summary || 'なし') + '</span>'
            + '</div>'
            + '<div class="section-label">時系列</div><p class="detail-text">' + escapeHtml(getPlacementSummary(selected, byId)) + '</p>'
            + '<div class="section-label">GM</div><div class="meta-row">' + (selected.gm ? '<span class="tag">' + escapeHtml(selected.gm) + '</span>' : '<span class="tag">なし</span>') + '</div>'
            + '<div class="section-label">舞台</div><div class="meta-row">' + (selected.stage ? '<span class="tag">' + escapeHtml(selected.stage) + '</span>' : '<span class="tag">未設定</span>') + '</div>'
            + '<div class="section-label">タグ</div><div class="meta-row">' + tagMarkup + '</div>'
            + '<div class="section-label">参加PC</div><div class="meta-row">' + ((selected.pcs || []).map((v) => '<span class="tag">' + escapeHtml(v) + '</span>').join('') || '<span class="tag">なし</span>') + '</div>'
            + '<div class="section-label">登場NPC</div><div class="meta-row">' + ((selected.npcs || []).map((v) => '<span class="tag">' + escapeHtml(v) + '</span>').join('') || '<span class="tag">なし</span>') + '</div>'
            + '<div class="section-label">トレーラー</div><p class="detail-text">' + escapeHtml(selected.information.trailer || 'なし') + '</p>'
            + '<div class="section-label">詳細</div><p class="detail-text">' + escapeHtml(selected.information.description || '詳細なし') + '</p>'
            + '</div>';
        }

        function getStoryLaneKey(scenario) {
          return scenario && scenario.tagIds && scenario.tagIds[0] ? scenario.tagIds[0] : '__untagged__';
        }

        function computeStoryLaneLayout(scenarios) {
          const scenariosByMonth = new Map();
          scenarios.forEach((scenario) => {
            const key = getMonthKey(scenario);
            if (!scenariosByMonth.has(key)) scenariosByMonth.set(key, []);
            scenariosByMonth.get(key).push(scenario);
          });
          const rowById = new Map();
          scenariosByMonth.forEach((monthScenarios) => {
            const scenarioMap = new Map(monthScenarios.map((scenario) => [scenario.id, scenario]));
            const depthById = new Map();
            const resolveDepth = (scenarioId, seen = new Set()) => {
              if (seen.has(scenarioId)) return 0;
              if (depthById.has(scenarioId)) return depthById.get(scenarioId);
              seen.add(scenarioId);
              const scenario = scenarioMap.get(scenarioId);
              const reference = scenario && scenario.placement ? scenarioMap.get(scenario.placement.referenceScenarioId) : null;
              const depth = reference ? resolveDepth(reference.id, seen) + (scenario.placement.relation === 'after' ? 1 : 0) : 0;
              depthById.set(scenarioId, depth);
              return depth;
            };
            const adjacency = new Map(monthScenarios.map((scenario) => [scenario.id, new Set()]));
            monthScenarios.forEach((scenario) => {
              const referenceId = scenario.placement && scenario.placement.relation === 'same' ? scenario.placement.referenceScenarioId : null;
              if (!referenceId || !adjacency.has(referenceId)) return;
              adjacency.get(scenario.id).add(referenceId);
              adjacency.get(referenceId).add(scenario.id);
            });
            const visited = new Set();
            monthScenarios.forEach((scenario) => {
              if (visited.has(scenario.id)) return;
              const component = [];
              const stack = [scenario.id];
              visited.add(scenario.id);
              while (stack.length) {
                const currentId = stack.pop();
                component.push(currentId);
                adjacency.get(currentId).forEach((neighborId) => {
                  if (visited.has(neighborId)) return;
                  visited.add(neighborId);
                  stack.push(neighborId);
                });
              }
              const row = Math.max(...component.map((id) => resolveDepth(id)));
              component.forEach((id) => rowById.set(id, row));
            });
          });
          const getTimelineOrder = (scenario) => (scenario.year * 12 + scenario.month) * 1000 + (rowById.get(scenario.id) || 0);
          const stories = new Map();
          scenarios.forEach((scenario, index) => {
            const key = getStoryLaneKey(scenario);
            const order = getTimelineOrder(scenario);
            if (!stories.has(key)) stories.set(key, { key, start: order, end: order, firstIndex: index, width: 1, branchById: new Map() });
            const story = stories.get(key);
            story.start = Math.min(story.start, order);
            story.end = Math.max(story.end, order);
          });
          const scenariosByStoryRow = new Map();
          scenarios.forEach((scenario) => {
            const key = getStoryLaneKey(scenario) + ':' + getTimelineOrder(scenario);
            if (!scenariosByStoryRow.has(key)) scenariosByStoryRow.set(key, []);
            scenariosByStoryRow.get(key).push(scenario);
          });
          scenariosByStoryRow.forEach((rowScenarios) => {
            const story = stories.get(getStoryLaneKey(rowScenarios[0]));
            rowScenarios.slice().sort((a, b) => {
              const priorityDiff = Number(b.xPriority || 1) - Number(a.xPriority || 1);
              return priorityDiff || String(a.title || '').localeCompare(String(b.title || ''));
            }).forEach((scenario, index) => story.branchById.set(scenario.id, index));
            story.width = Math.max(story.width, rowScenarios.length);
          });
          const assignedStories = [];
          [...stories.values()].filter((story) => story.key !== '__untagged__').sort((a, b) => a.start - b.start || a.firstIndex - b.firstIndex || a.key.localeCompare(b.key)).forEach((story) => {
            const activeStories = assignedStories.filter((assigned) => assigned.end >= story.start);
            let column = 0;
            while (activeStories.some((assigned) => column < assigned.column + assigned.width && column + story.width > assigned.column)) column += 1;
            story.column = column;
            assignedStories.push(story);
          });
          const untaggedStory = stories.get('__untagged__');
          if (untaggedStory) untaggedStory.column = assignedStories.reduce((rightmost, story) => Math.max(rightmost, story.column + story.width), 0);
          const layoutById = new Map();
          scenarios.forEach((scenario) => {
            const story = stories.get(getStoryLaneKey(scenario));
            layoutById.set(scenario.id, {
              x: (story.column + (story.branchById.get(scenario.id) || 0)) * 280,
              y: (rowById.get(scenario.id) || 0) * 120
            });
          });
          return layoutById;
        }

        function computeMonthLayout(monthScenarios, placementState = null) {
          const scenarioMap = new Map(monthScenarios.map((s) => [s.id, s]));
          const depthMap = new Map();
          const sameGroupMap = new Map();

          const getScenarioPriority = (scenario) => Number.isFinite(Number(scenario && scenario.xPriority)) ? Number(scenario.xPriority) : 9999;

          const compareLowPriorityFirst = (a, b) => {
            const diff = getScenarioPriority(b) - getScenarioPriority(a);
            if (diff !== 0) return diff;
            return String(a.title || '').localeCompare(String(b.title || ''));
          };

          const compareWithinSameGroup = (a, b) => {
            const diff = getScenarioPriority(a) - getScenarioPriority(b);
            if (diff !== 0) return diff;
            return String(a.title || '').localeCompare(String(b.title || ''));
          };

          function resolveDepth(scenarioId, seen = new Set()) {
            if (seen.has(scenarioId)) return 0;
            if (depthMap.has(scenarioId)) return depthMap.get(scenarioId);
            seen.add(scenarioId);
            const scenario = scenarioMap.get(scenarioId);
            if (!scenario || !scenario.placement) {
              depthMap.set(scenarioId, 0);
              return 0;
            }
            const ref = scenarioMap.get(scenario.placement.referenceScenarioId);
            if (!ref) {
              depthMap.set(scenarioId, 0);
              return 0;
            }
            const baseDepth = resolveDepth(ref.id, seen);
            const nextDepth = scenario.placement.relation === 'same' ? baseDepth : baseDepth + 1;
            depthMap.set(scenarioId, nextDepth);
            return nextDepth;
          }

          monthScenarios.forEach((scenario) => {
            const ref = scenario.placement && scenarioMap.get(scenario.placement.referenceScenarioId);
            if (scenario.placement && scenario.placement.relation === 'same' && ref) {
              const refGroup = sameGroupMap.get(ref.id) || new Set([ref.id]);
              refGroup.add(scenario.id);
              sameGroupMap.set(ref.id, refGroup);
              sameGroupMap.set(scenario.id, refGroup);
            }
          });

          monthScenarios.forEach((scenario) => resolveDepth(scenario.id));

          const rows = new Map();
          monthScenarios.forEach((scenario) => {
            const depth = depthMap.get(scenario.id) || 0;
            const group = sameGroupMap.get(scenario.id) || new Set([scenario.id]);
            const maxDepth = Math.max(...[...group].map((id) => depthMap.get(id) || 0));
            rows.set(scenario.id, maxDepth);
          });

          const connectedSet = new Set();
          monthScenarios.forEach((scenarioA, index) => {
            monthScenarios.slice(index + 1).forEach((scenarioB) => {
              if (hasSameParticipantName(scenarioA, scenarioB)) {
                connectedSet.add(scenarioA.id);
                connectedSet.add(scenarioB.id);
              }
            });
          });

          const rowGroups = new Map();
          monthScenarios.forEach((scenario) => {
            const row = rows.get(scenario.id) || 0;
            if (!rowGroups.has(row)) rowGroups.set(row, []);
            rowGroups.get(row).push(scenario);
          });

          function buildSameComponents(rowScenarios) {
            const adjacency = new Map(rowScenarios.map((scenario) => [scenario.id, new Set()]));
            rowScenarios.forEach((scenario) => {
              const refId = scenario.placement && scenario.placement.relation === 'same' ? scenario.placement.referenceScenarioId : null;
              if (!refId || !adjacency.has(refId)) return;
              adjacency.get(scenario.id).add(refId);
              adjacency.get(refId).add(scenario.id);
            });

            const visited = new Set();
            const groups = [];
            rowScenarios.forEach((scenario) => {
              if (visited.has(scenario.id)) return;
              const stack = [scenario.id];
              const group = [];
              visited.add(scenario.id);
              while (stack.length) {
                const currentId = stack.pop();
                const currentScenario = scenarioMap.get(currentId);
                if (currentScenario && rowScenarios.some((item) => item.id === currentId)) {
                  group.push(currentScenario);
                }
                (adjacency.get(currentId) || []).forEach((neighborId) => {
                  if (!visited.has(neighborId)) {
                    visited.add(neighborId);
                    stack.push(neighborId);
                  }
                });
              }
              groups.push(group.sort(compareWithinSameGroup));
            });
            return groups;
          }

          function hasSameMonthPlacementLink(sourceScenario, targetScenario) {
            if (!sourceScenario || !targetScenario) return false;
            if (sourceScenario.year !== targetScenario.year || sourceScenario.month !== targetScenario.month) return false;
            const sourceRefId = sourceScenario.placement && sourceScenario.placement.referenceScenarioId ? sourceScenario.placement.referenceScenarioId : null;
            const targetRefId = targetScenario.placement && targetScenario.placement.referenceScenarioId ? targetScenario.placement.referenceScenarioId : null;
            return sourceRefId === targetScenario.id || targetRefId === sourceScenario.id;
          }

          function getPlacedConnectionColumns(scenario, placedById) {
            const candidates = [];
            placedById.forEach((column, placedId) => {
              const placedScenario = scenarioMap.get(placedId);
              if (!placedScenario) return;
              const hasParticipantConnection = hasSameParticipantName(scenario, placedScenario);
              const hasPlacementConnection = hasSameMonthPlacementLink(scenario, placedScenario);
              if (!hasParticipantConnection && !hasPlacementConnection) return;
              candidates.push({ scenario: placedScenario, column, row: rows.get(placedId) || 0 });
            });
            return candidates.sort((a, b) => {
              const rowDiff = b.row - a.row;
              if (rowDiff !== 0) return rowDiff;
              return a.column - b.column;
            });
          }

          function findNearestFreeColumn(targetColumn, rowTaken, usedColumns) {
            const maxColumn = Math.max(targetColumn + 1, usedColumns.size + rowTaken.size + 2);
            for (let offset = 0; offset <= maxColumn + 2; offset += 1) {
              const left = targetColumn - offset;
              if (left >= 0 && !rowTaken.has(left)) return left;
              const right = targetColumn + offset;
              if (!rowTaken.has(right)) return right;
            }
            return Math.max(0, targetColumn);
          }

          function findLeftmostFreeColumn(rowTaken, usedColumns) {
            const limit = usedColumns.size + rowTaken.size + 2;
            for (let column = 0; column <= limit; column += 1) {
              if (!rowTaken.has(column)) return column;
            }
            return limit + 1;
          }

          const xColumns = new Map();
          const placedById = placementState && placementState.placedById ? placementState.placedById : new Map();
          const usedColumns = placementState && placementState.usedColumns ? placementState.usedColumns : new Set();

          [...rowGroups.keys()].sort((a, b) => a - b).forEach((row) => {
            const rowScenarios = rowGroups.get(row).slice().sort(compareLowPriorityFirst);
            const rowTaken = new Set();
            const rowPlaced = new Set();
            const sameComponents = buildSameComponents(rowScenarios);

            const anchored = [];
            rowScenarios.forEach((scenario) => {
              const connectedColumns = getPlacedConnectionColumns(scenario, placedById);
              if (!connectedColumns.length) return;
              anchored.push({ scenario, targetColumn: connectedColumns[0].column, connectedColumns });
            });

            const anchoredByTarget = new Map();
            anchored.forEach((entry) => {
              if (!anchoredByTarget.has(entry.targetColumn)) anchoredByTarget.set(entry.targetColumn, []);
              anchoredByTarget.get(entry.targetColumn).push(entry);
            });

            [...anchoredByTarget.keys()].sort((a, b) => a - b).forEach((targetColumn) => {
              const entries = anchoredByTarget.get(targetColumn).sort((a, b) => compareLowPriorityFirst(a.scenario, b.scenario));
              entries.forEach((entry, index) => {
                const column = index === 0 && !rowTaken.has(targetColumn)
                  ? targetColumn
                  : findNearestFreeColumn(targetColumn, rowTaken, usedColumns);
                xColumns.set(entry.scenario.id, column);
                placedById.set(entry.scenario.id, column);
                rowPlaced.add(entry.scenario.id);
                rowTaken.add(column);
                usedColumns.add(column);
              });
            });

            const sameExpansionEntries = [];
            sameComponents.forEach((group) => {
              const anchoredMembers = group.filter((scenario) => rowPlaced.has(scenario.id));
              const unplacedMembers = group.filter((scenario) => !rowPlaced.has(scenario.id));
              if (!anchoredMembers.length || !unplacedMembers.length) return;
              const anchorColumn = Math.min(...anchoredMembers.map((scenario) => xColumns.get(scenario.id) || 0));
              const orderedMembers = unplacedMembers.sort(compareWithinSameGroup);
              orderedMembers.forEach((scenario, offset) => {
                sameExpansionEntries.push({ scenario, targetColumn: anchorColumn + anchoredMembers.length + offset });
              });
            });

            sameExpansionEntries
              .sort((a, b) => a.targetColumn - b.targetColumn || compareWithinSameGroup(a.scenario, b.scenario))
              .forEach((entry) => {
                if (rowPlaced.has(entry.scenario.id)) return;
                const column = rowTaken.has(entry.targetColumn)
                  ? findNearestFreeColumn(entry.targetColumn, rowTaken, usedColumns)
                  : entry.targetColumn;
                xColumns.set(entry.scenario.id, column);
                placedById.set(entry.scenario.id, column);
                rowPlaced.add(entry.scenario.id);
                rowTaken.add(column);
                usedColumns.add(column);
              });

            const deferredGroups = sameComponents
              .filter((group) => group.some((scenario) => !rowPlaced.has(scenario.id)))
              .sort((groupA, groupB) => {
                const priorityDiff = Math.max(...groupB.map(getScenarioPriority)) - Math.max(...groupA.map(getScenarioPriority));
                if (priorityDiff !== 0) return priorityDiff;
                return String(groupA[0].title || '').localeCompare(String(groupB[0].title || ''));
              });

            deferredGroups.forEach((group) => {
              const remaining = group.filter((scenario) => !rowPlaced.has(scenario.id)).sort(compareWithinSameGroup);
              if (!remaining.length) return;
              let column = findLeftmostFreeColumn(rowTaken, usedColumns);
              remaining.forEach((scenario, index) => {
                const nextColumn = index === 0 ? column : findNearestFreeColumn(column + index, rowTaken, usedColumns);
                xColumns.set(scenario.id, nextColumn);
                placedById.set(scenario.id, nextColumn);
                rowPlaced.add(scenario.id);
                rowTaken.add(nextColumn);
                usedColumns.add(nextColumn);
              });
            });

            rowScenarios
              .filter((scenario) => !rowPlaced.has(scenario.id))
              .sort(compareLowPriorityFirst)
              .forEach((scenario) => {
                const column = findLeftmostFreeColumn(rowTaken, usedColumns);
                xColumns.set(scenario.id, column);
                placedById.set(scenario.id, column);
                rowPlaced.add(scenario.id);
                rowTaken.add(column);
                usedColumns.add(column);
              });
          });

          const orderedIds = monthScenarios
            .slice()
            .sort((a, b) => {
              const rowDiff = (rows.get(a.id) || 0) - (rows.get(b.id) || 0);
              if (rowDiff !== 0) return rowDiff;
              return (xColumns.get(a.id) || 0) - (xColumns.get(b.id) || 0);
            })
            .map((scenario) => scenario.id);

          const xMap = new Map();
          const laneWidth = 240;
          const laneGap = 70;
          orderedIds.forEach((id) => {
            xMap.set(id, (xColumns.get(id) || 0) * (laneWidth + laneGap));
          });

          return monthScenarios.map((scenario) => ({
            ...scenario,
            x: xMap.get(scenario.id) || 0,
            y: (rows.get(scenario.id) || 0) * 120,
            connected: connectedSet.has(scenario.id)
          }));
        }

        function getSharedParticipantPairIdsByVisualOrder(positionedScenarios) {
          const participantMap = new Map();
          positionedScenarios.forEach((item) => {
            const participants = [...new Set([...(item.scenario.pcs || []), ...(item.scenario.npcs || [])])];
            participants.forEach((participant) => {
              if (!participantMap.has(participant)) participantMap.set(participant, []);
              participantMap.get(participant).push(item);
            });
          });

          const pairIds = new Set();
          participantMap.forEach((scenariosForParticipant) => {
            const uniqueScenarios = [...new Map(
              scenariosForParticipant.map((item) => [item.scenario.id, item])
            ).values()].sort((a, b) => {
              const yDiff = a.rect.cy - b.rect.cy;
              if (Math.abs(yDiff) > 0.01) return yDiff;
              const xDiff = a.rect.cx - b.rect.cx;
              if (Math.abs(xDiff) > 0.01) return xDiff;
              return String(a.scenario.title || '').localeCompare(String(b.scenario.title || ''));
            });

            for (let index = 1; index < uniqueScenarios.length; index += 1) {
              const previous = uniqueScenarios[index - 1];
              const current = uniqueScenarios[index];
              pairIds.add([previous.scenario.id, current.scenario.id].sort().join(':'));
            }
          });

          return pairIds;
        }

        function getRectFromCard(card, timelineRect) {
          const rect = card.getBoundingClientRect();
          return {
            left: rect.left - timelineRect.left,
            top: rect.top - timelineRect.top,
            right: rect.right - timelineRect.left,
            bottom: rect.bottom - timelineRect.top,
            width: rect.width,
            height: rect.height,
            cx: rect.left - timelineRect.left + rect.width / 2,
            cy: rect.top - timelineRect.top + rect.height / 2
          };
        }

        function rectIntersectsSegment(rect, p1, p2) {
          const padding = 18;
          const minX = Math.min(p1.x, p2.x) - padding;
          const maxX = Math.max(p1.x, p2.x) + padding;
          const minY = Math.min(p1.y, p2.y) - padding;
          const maxY = Math.max(p1.y, p2.y) + padding;
          const inflatedRect = {
            left: rect.left - padding,
            top: rect.top - padding,
            right: rect.right + padding,
            bottom: rect.bottom + padding
          };
          return !(maxX < inflatedRect.left || minX > inflatedRect.right || maxY < inflatedRect.top || minY > inflatedRect.bottom);
        }

        function inflateRect(rect, padding) {
          return {
            left: rect.left - padding,
            top: rect.top - padding,
            right: rect.right + padding,
            bottom: rect.bottom + padding
          };
        }

        function segmentIntersectsInflatedRect(p1, p2, rect, padding) {
          const inflated = inflateRect(rect, padding == null ? 12 : padding);
          const minX = Math.min(p1.x, p2.x);
          const maxX = Math.max(p1.x, p2.x);
          const minY = Math.min(p1.y, p2.y);
          const maxY = Math.max(p1.y, p2.y);

          if (Math.abs(p1.x - p2.x) < 0.01) {
            return p1.x >= inflated.left && p1.x <= inflated.right && maxY >= inflated.top && minY <= inflated.bottom;
          }
          if (Math.abs(p1.y - p2.y) < 0.01) {
            return p1.y >= inflated.top && p1.y <= inflated.bottom && maxX >= inflated.left && minX <= inflated.right;
          }
          return rectIntersectsSegment(inflated, p1, p2);
        }

        function routeIntersectsAnyCard(points, cardEntries, protectedCards) {
          for (let index = 0; index < points.length - 1; index += 1) {
            const start = points[index];
            const end = points[index + 1];
            for (let cardIndex = 0; cardIndex < cardEntries.length; cardIndex += 1) {
              const cardEntry = cardEntries[cardIndex];
              if (protectedCards.has(cardEntry.card)) continue;
              if (segmentIntersectsInflatedRect(start, end, cardEntry.rect, 8)) {
                return true;
              }
            }
          }
          return false;
        }

        function uniqueSortedNumbers(values) {
          return [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
        }

        function buildAxisCandidates(intervals, preferred, fallbackMin, fallbackMax, gapPadding) {
          const candidates = [preferred, fallbackMin, fallbackMax];
          const actualGapPadding = gapPadding == null ? 16 : gapPadding;
          if (!intervals.length) return uniqueSortedNumbers(candidates);
          const sorted = intervals.slice().sort((a, b) => a.left - b.left);
          candidates.push(sorted[0].left - actualGapPadding, sorted[sorted.length - 1].right + actualGapPadding);
          for (let index = 0; index < sorted.length - 1; index += 1) {
            const current = sorted[index];
            const next = sorted[index + 1];
            if (next.left - current.right >= actualGapPadding * 2) {
              candidates.push((current.right + next.left) / 2);
            }
          }
          return uniqueSortedNumbers(candidates);
        }

        function scoreOrthogonalRoute(points, preferredAxisValue) {
          let length = 0;
          for (let index = 0; index < points.length - 1; index += 1) {
            length += Math.abs(points[index].x - points[index + 1].x) + Math.abs(points[index].y - points[index + 1].y);
          }
          const bendPenalty = Math.max(0, points.length - 2) * 12;
          const axisPenalty = preferredAxisValue == null ? 0 : Math.abs((points[1] ? points[1].x : preferredAxisValue) - preferredAxisValue);
          return length + bendPenalty + axisPenalty;
        }

        function dedupeConsecutivePoints(points) {
          if (!Array.isArray(points) || points.length === 0) return [];
          const result = [points[0]];
          for (let index = 1; index < points.length; index += 1) {
            const prev = result[result.length - 1];
            const current = points[index];
            if (Math.abs(prev.x - current.x) < 0.01 && Math.abs(prev.y - current.y) < 0.01) continue;
            result.push(current);
          }
          return result;
        }

        function simplifyOrthogonalPoints(points) {
          if (!Array.isArray(points) || points.length <= 2) return points || [];
          const epsilon = 0.01;
          const deduped = dedupeConsecutivePoints(points);
          if (deduped.length <= 2) return deduped;
          const simplified = [deduped[0]];
          for (let index = 1; index < deduped.length - 1; index += 1) {
            const prev = simplified[simplified.length - 1];
            const current = deduped[index];
            const next = deduped[index + 1];
            const sameX = Math.abs(prev.x - current.x) < epsilon && Math.abs(current.x - next.x) < epsilon;
            const sameY = Math.abs(prev.y - current.y) < epsilon && Math.abs(current.y - next.y) < epsilon;
            if (sameX || sameY) continue;
            simplified.push(current);
          }
          simplified.push(deduped[deduped.length - 1]);
          return dedupeConsecutivePoints(simplified);
        }

        function toSvgPathData(points) {
          return points.map((point, index) => (index === 0 ? 'M' : 'L') + ' ' + point.x + ' ' + point.y).join(' ');
        }

        function createConnectionLayerSvg(className) {
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('class', className);
          svg.setAttribute('aria-hidden', 'true');
          return svg;
        }

        function collectConnections(cards, visibleMap, timelineRect, validPairIds) {
          const connections = [];
          for (let i = 0; i < cards.length; i += 1) {
            for (let j = i + 1; j < cards.length; j += 1) {
              const a = cards[i];
              const b = cards[j];
              const scenarioA = visibleMap.get(a.dataset.scenarioId);
              const scenarioB = visibleMap.get(b.dataset.scenarioId);
              if (!scenarioA || !scenarioB) continue;
              if (!hasSameParticipantName(scenarioA, scenarioB)) continue;
              const pairKey = [scenarioA.id, scenarioB.id].sort().join(':');
              if (!validPairIds.has(pairKey)) continue;

              const rectA = getRectFromCard(a, timelineRect);
              const rectB = getRectFromCard(b, timelineRect);
              const sameRelation = scenarioA.placement && scenarioA.placement.relation === 'same'
                && scenarioA.placement.referenceScenarioId === scenarioB.id
                || scenarioB.placement && scenarioB.placement.relation === 'same'
                && scenarioB.placement.referenceScenarioId === scenarioA.id;
              const preferVertical = !sameRelation;
              const sourceAboveTarget = rectA.cy < rectB.cy;
              const sourceLeftOfTarget = rectA.cx < rectB.cx;

              connections.push({
                a,
                b,
                rectA,
                rectB,
                preferVertical,
                sourceAboveTarget,
                sourceLeftOfTarget,
                startEdge: preferVertical ? (sourceAboveTarget ? 'bottom' : 'top') : (sourceLeftOfTarget ? 'right' : 'left'),
                endEdge: preferVertical ? (sourceAboveTarget ? 'top' : 'bottom') : (sourceLeftOfTarget ? 'left' : 'right'),
                startLane: 0,
                endLane: 0,
                scenarioA,
                scenarioB
              });
            }
          }
          return connections;
        }

        function ensureConnectionTooltip() {
          let tooltip = document.getElementById('connection-tooltip');
          if (!tooltip) {
            tooltip = document.createElement('div');
            tooltip.id = 'connection-tooltip';
            tooltip.className = 'connection-tooltip hidden';
            timelineEl.appendChild(tooltip);
          }
          return tooltip;
        }

        function hideConnectionTooltip() {
          const tooltip = document.getElementById('connection-tooltip');
          if (tooltip) tooltip.classList.add('hidden');
        }

        function hideTooltip() {
          hideConnectionTooltip();
        }

        window.hideTooltip = hideTooltip;
        window.hideConnectionTooltip = hideConnectionTooltip;

        function renderConnectionTooltip(event, connection) {
          const tooltip = ensureConnectionTooltip();
          const scenarioA = connection.scenarioA;
          const scenarioB = connection.scenarioB;
          const sharedNames = new Set(getSharedParticipants(scenarioA, scenarioB));
          const formatCategory = (items) => (items || []).filter((item) => sharedNames.has(item));
          const buildSection = (label, items) => items.length ? '<div class="connection-tooltip-section">' + label + '：' + escapeHtml(items.join('、')) + '</div>' : '';

          tooltip.innerHTML = ''
            + '<div class="connection-tooltip-title">' + escapeHtml(scenarioA.title) + '</div>'
            + buildSection('PC', formatCategory(scenarioA.pcs || []))
            + buildSection('NPC', formatCategory(scenarioA.npcs || []))
            + '<div class="connection-tooltip-title" style="margin-top:8px;">' + escapeHtml(scenarioB.title) + '</div>'
            + buildSection('PC', formatCategory(scenarioB.pcs || []))
            + buildSection('NPC', formatCategory(scenarioB.npcs || []));

          tooltip.classList.remove('hidden');
          const maxLeft = Math.max(12, window.innerWidth - tooltip.offsetWidth - 12);
          const maxTop = Math.max(12, window.innerHeight - tooltip.offsetHeight - 12);
          tooltip.style.left = Math.min(event.clientX + 14, maxLeft) + 'px';
          tooltip.style.top = Math.min(event.clientY + 18, maxTop) + 'px';
        }

        function appendConnectionPathElements(hitSvg, visualSvg, d, connection) {
          const hitTarget = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          hitTarget.setAttribute('d', d);
          hitTarget.setAttribute('class', 'connection-hit-target');
          hitTarget.addEventListener('click', (event) => {
            event.stopPropagation();
            renderConnectionTooltip(event, connection);
          });
          hitTarget.addEventListener('mouseleave', hideConnectionTooltip);
          hitSvg.appendChild(hitTarget);

          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          path.setAttribute('class', 'connection-line');
          path.setAttribute('pointer-events', 'none');
          const exportTags = window.__exportTags || [];
          const sourceTags = getScenarioTags(connection.scenarioA, exportTags);
          const targetTags = getScenarioTags(connection.scenarioB, exportTags);
          if (sourceTags.length && targetTags.length) {
            path.style.stroke = sourceTags[0].color;
          }
          visualSvg.appendChild(path);
        }

        function renderConnections(visibleScenarios) {
          ensureConnectionTooltip();
          const old = timelineEl.querySelectorAll('.timeline-overlay');
          old.forEach((node) => node.remove());

          const visualSvg = createConnectionLayerSvg('timeline-overlay');
          const hitSvg = createConnectionLayerSvg('timeline-overlay hit-overlay');
          const overlayWidth = Math.max(timelineEl.clientWidth, timelineEl.scrollWidth);
          const overlayHeight = Math.max(timelineEl.clientHeight, timelineEl.scrollHeight);
          [visualSvg, hitSvg].forEach((svg) => {
            svg.style.width = overlayWidth + 'px';
            svg.style.height = overlayHeight + 'px';
            svg.setAttribute('viewBox', '0 0 ' + overlayWidth + ' ' + overlayHeight);
          });
          const cards = [...timelineEl.querySelectorAll('.scenario-card')];
          if (cards.length < 2) {
            timelineEl.appendChild(visualSvg);
            timelineEl.appendChild(hitSvg);
            return;
          }

          const timelineRect = timelineEl.getBoundingClientRect();
          const cardRects = cards.map((card) => getRectFromCard(card, timelineRect));
          const visibleMap = new Map(visibleScenarios.map((scenario) => [scenario.id, scenario]));
          const positionedScenarios = cards.map((card, index) => {
            const scenario = visibleMap.get(card.dataset.scenarioId);
            if (!scenario) return null;
            return { card, scenario, rect: cardRects[index] };
          }).filter(Boolean);

          const validPairIds = getSharedParticipantPairIdsByVisualOrder(positionedScenarios);
          const connections = collectConnections(cards, visibleMap, timelineRect, validPairIds);
          routeExportConnections(connections, cardRects, cards).forEach(({ connection, points }) => {
            const optimizedPoints = simplifyOrthogonalPoints(points);
            const d = toSvgPathData(optimizedPoints);
            appendConnectionPathElements(hitSvg, visualSvg, d, connection);
          });

          timelineEl.appendChild(visualSvg);
          timelineEl.appendChild(hitSvg);
        }

        function getExportMiddleSegments(points) {
          const segments = [];
          for (let index = 1; index < points.length - 2; index += 1) {
            const start = points[index];
            const end = points[index + 1];
            if (Math.abs(start.x - end.x) >= 0.01 || Math.abs(start.y - end.y) >= 0.01) {
              segments.push({ start, end });
            }
          }
          return segments;
        }

        function exportSegmentsConflict(first, second, gap = 8) {
          const firstHorizontal = Math.abs(first.start.y - first.end.y) < 0.01;
          const secondHorizontal = Math.abs(second.start.y - second.end.y) < 0.01;
          const firstVertical = Math.abs(first.start.x - first.end.x) < 0.01;
          const secondVertical = Math.abs(second.start.x - second.end.x) < 0.01;
          if (firstHorizontal && secondHorizontal) {
            return Math.abs(first.start.y - second.start.y) < gap
              && Math.max(first.start.x, first.end.x) >= Math.min(second.start.x, second.end.x)
              && Math.max(second.start.x, second.end.x) >= Math.min(first.start.x, first.end.x);
          }
          if (firstVertical && secondVertical) {
            return Math.abs(first.start.x - second.start.x) < gap
              && Math.max(first.start.y, first.end.y) >= Math.min(second.start.y, second.end.y)
              && Math.max(second.start.y, second.end.y) >= Math.min(first.start.y, first.end.y);
          }
          return false;
        }

        function buildExportCandidate(connection, axis) {
          const rectA = connection.rectA;
          const rectB = connection.rectB;
          const stemLength = 8;
          if (connection.preferVertical) {
            const above = rectA.cy < rectB.cy;
            const start = { x: rectA.cx, y: above ? rectA.bottom : rectA.top };
            const end = { x: rectB.cx, y: above ? rectB.top : rectB.bottom };
            const startExit = { x: start.x, y: above ? start.y + stemLength : start.y - stemLength };
            const endExit = { x: end.x, y: above ? end.y - stemLength : end.y + stemLength };
            return [start, startExit, { x: axis, y: startExit.y }, { x: axis, y: endExit.y }, endExit, end];
          }
          const left = rectA.cx < rectB.cx;
          const start = { x: left ? rectA.right : rectA.left, y: rectA.cy };
          const end = { x: left ? rectB.left : rectB.right, y: rectB.cy };
          const startExit = { x: left ? start.x + stemLength : start.x - stemLength, y: start.y };
          const endExit = { x: left ? end.x - stemLength : end.x + stemLength, y: end.y };
          return [start, startExit, { x: startExit.x, y: axis }, { x: endExit.x, y: axis }, endExit, end];
        }

        function routeExportConnections(connections, cardRects, cards) {
          const cardEntries = cardRects.map((rect, index) => ({ rect, card: cards[index] }));
          const reserved = [];
          return connections
            .slice()
            .sort((a, b) => {
              const directA = a.preferVertical ? Math.abs(a.rectA.cx - a.rectB.cx) : Math.abs(a.rectA.cy - a.rectB.cy);
              const directB = b.preferVertical ? Math.abs(b.rectA.cx - b.rectB.cx) : Math.abs(b.rectA.cy - b.rectB.cy);
              return directA - directB;
            })
            .map((connection) => {
              const preferredAxis = connection.preferVertical
                ? (connection.rectA.cx + connection.rectB.cx) / 2
                : (connection.rectA.cy + connection.rectB.cy) / 2;
              const axes = [preferredAxis, connection.preferVertical ? connection.rectA.cx : connection.rectA.cy, connection.preferVertical ? connection.rectB.cx : connection.rectB.cy];
              for (let step = 1; step <= 8; step += 1) axes.push(preferredAxis - step * 8, preferredAxis + step * 8);
              let best = null;
              axes.forEach((axis) => {
                const raw = buildExportCandidate(connection, axis);
                const points = simplifyOrthogonalPoints(raw);
                if (routeIntersectsAnyCard(points, cardEntries, new Set([connection.a, connection.b]))) return;
                const middle = getExportMiddleSegments(raw);
                if (middle.some((segment) => reserved.some((item) => exportSegmentsConflict(segment, item.segment)))) return;
                const branchDistance = connection.preferVertical ? Math.abs(axis - connection.rectA.cx) : Math.abs(axis - connection.rectA.cy);
                const score = branchDistance * 1000 + Math.abs(axis - preferredAxis);
                if (!best || score < best.score) best = { points, middle, score };
              });
              const result = best || { points: buildExportCandidate(connection, preferredAxis), middle: [] };
              result.middle.forEach((segment) => reserved.push({ segment }));
              return { connection, points: result.points };
            });
        }

        function main() {
          try {
            let parsed;
            try {
              parsed = JSON.parse(dataNode.textContent || '{}');
            } catch (error) {
              timelineEl.innerHTML = '<div class="empty">データ読み込みに失敗しました</div>';
              detailEl.innerHTML = '<div class="empty">データ読み込みに失敗しました</div>';
              return;
            }

            const tags = Array.isArray(parsed.tags) ? parsed.tags.map(normalizeTag) : [];
            window.__exportTags = tags;
            const scenarios = Array.isArray(parsed.scenarios) ? parsed.scenarios.map(normalizeScenario) : [];
            const byId = new Map(scenarios.map((s) => [s.id, s]));
            let selectedId = scenarios[0] ? scenarios[0].id : null;
            let keyword = '';
            const filters = {
              title: '',
              summary: '',
              gm: '',
              character: '',
              tagNames: [],
              stageNames: [],
              tagMode: 'or',
              yearFrom: null,
              yearTo: null,
              monthFrom: null,
              monthTo: null
            };

          function updateFiltersFromControls() {
            filters.title = String(filterTitleEl.value || '').trim().toLowerCase();
            filters.summary = String(filterSummaryEl.value || '').trim().toLowerCase();
            filters.gm = String(filterGmEl.value || '').trim().toLowerCase();
            filters.character = String(filterCharacterEl.value || '').trim().toLowerCase();
            filters.tagNames = parseCsv(filterTagsEl.value);
            filters.stageNames = parseCsv(filterStageNamesEl.value);
            filters.tagMode = filterTagModeEl.value === 'and' ? 'and' : 'or';
            filters.yearFrom = parseOptionalNumber(filterYearFromEl.value, 1, 999);
            filters.yearTo = parseOptionalNumber(filterYearToEl.value, 1, 999);
            filters.monthFrom = parseOptionalNumber(filterMonthFromEl.value, 1, 12);
            filters.monthTo = parseOptionalNumber(filterMonthToEl.value, 1, 12);
          }

          function matchesScenario(s) {
            const tagsText = getScenarioTags(s, tags).map((tag) => tag.name).join(' ');
            const target = [
              s.title,
              s.summary,
              s.stage,
              s.gm,
              ...(s.pcs || []),
              ...(s.npcs || []),
              tagsText,
              s.information.trailer,
              s.information.description
            ].join(' ').toLowerCase();

            if (keyword && !target.includes(keyword)) return false;

            if (filters.title && !String(s.title || '').toLowerCase().includes(filters.title)) return false;
            if (filters.summary && !String(s.summary || '').toLowerCase().includes(filters.summary)) return false;
            if (filters.gm && !String(s.gm || '').toLowerCase().includes(filters.gm)) return false;
            if (filters.stageNames && filters.stageNames.length) {
              const normalizedStageNames = filters.stageNames.map((name) => name.toLowerCase());
              const scenarioStageText = String(s.stage || '').toLowerCase();
              const matched = normalizedStageNames.filter((name) => scenarioStageText.includes(name));
              if (matched.length === 0) return false;
            }

            if (filters.character) {
              const characters = [...(s.pcs || []), ...(s.npcs || [])].join(' ').toLowerCase();
              if (!characters.includes(filters.character)) return false;
            }

            if (filters.tagNames.length) {
              const scenarioTagNames = getScenarioTags(s, tags).map((tag) => tag.name.toLowerCase());
              const matched = filters.tagNames.filter((name) => scenarioTagNames.some((tagName) => tagName.includes(name)));
              if (filters.tagMode === 'and' && matched.length !== filters.tagNames.length) return false;
              if (filters.tagMode === 'or' && matched.length === 0) return false;
            }

            const fromOrder = (filters.yearFrom != null || filters.monthFrom != null)
              ? ((filters.yearFrom != null ? filters.yearFrom : 1) * 12 + (filters.monthFrom != null ? filters.monthFrom : 1))
              : null;
            const toOrder = (filters.yearTo != null || filters.monthTo != null)
              ? ((filters.yearTo != null ? filters.yearTo : 999) * 12 + (filters.monthTo != null ? filters.monthTo : 12))
              : null;
            const scenarioOrder = s.year * 12 + s.month;
            if (fromOrder != null && scenarioOrder < fromOrder) return false;
            if (toOrder != null && scenarioOrder > toOrder) return false;

            return true;
          }

          function render() {
            const visible = scenarios.filter(matchesScenario);
            statusEl.textContent = visible.length + ' / ' + scenarios.length + ' 件';

            if (!visible.length) {
              timelineEl.innerHTML = '<div class="empty">検索条件に一致するシナリオがありません</div>';
              detailEl.innerHTML = '<div class="empty">検索条件に一致するシナリオがありません</div>';
              if (typeof hideTooltip === 'function') hideTooltip();
              return;
            }

            if (!visible.some((s) => s.id === selectedId)) {
              selectedId = visible[0].id;
            }

            const monthMap = new Map();
            visible.forEach((scenario) => {
              const key = getMonthKey(scenario);
              if (!monthMap.has(key)) monthMap.set(key, []);
              monthMap.get(key).push(scenario);
            });

            const monthKeys = [...monthMap.keys()].sort((a, b) => {
              const [yearA, monthA] = a.split('-').map(Number);
              const [yearB, monthB] = b.split('-').map(Number);
              return yearA * 12 + monthA - (yearB * 12 + monthB);
            });

            const layoutById = computeStoryLaneLayout(scenarios);
            const htmlParts = [];

            monthKeys.forEach((key) => {
              const [year, month] = key.split('-').map(Number);
              const items = monthMap.get(key).slice();
              const layout = items.map((scenario) => Object.assign({}, scenario, layoutById.get(scenario.id) || { x: 0, y: 0 }));
              const maxY = Math.max(...layout.map((item) => item.y + 116), 140);
              const cards = layout.map((item) => {
                const gradient = getScenarioTagGradient(item, tags);
                const stripStyle = gradient ? ' style="background:' + escapeHtml(gradient) + ';"' : ' style="background:linear-gradient(90deg, rgba(148,163,184,0.4), rgba(148,163,184,0.15));"';
                const selected = item.id === selectedId ? ' selected' : '';
                return ''
                  + '<div class="scenario-card' + selected + '" data-scenario-id="' + escapeHtml(item.id) + '" style="left:' + item.x + 'px;top:' + item.y + 'px;">'
                  + '<div class="scenario-tag-strip"' + stripStyle + '></div>'
                  + '<div class="scenario-title">' + escapeHtml(item.title) + '</div>'
                  + '<div class="scenario-summary">' + escapeHtml(item.summary || '') + '</div>'
                  + '</div>';
              }).join('');

              htmlParts.push(''
                + '<section class="month-group">'
                + '<div class="month-header"><span>' + escapeHtml(getMonthLabel(year, month)) + '</span><span class="month-divider"></span></div>'
                + '<div class="timeline-layer" style="height:' + (maxY + 20) + 'px; width:' + (Math.max(680, Math.max(...layout.map((item) => item.x + 220), 0) + 40)) + 'px;">' + cards + '</div>'
                + '</section>');
            });

            timelineEl.innerHTML = '<div class="timeline-canvas">' + htmlParts.join('') + '</div>';

            timelineEl.querySelectorAll('.scenario-card').forEach((card) => {
              card.addEventListener('click', () => {
                selectedId = card.dataset.scenarioId;
                render();
              });
            });

            const selected = visible.find((s) => s.id === selectedId) || visible[0];
            renderDetail(selected, tags, byId);
            renderConnections(visible);
          }

          searchInput.addEventListener('input', () => {
            keyword = String(searchInput.value || '').trim().toLowerCase();
            render();
          });

          [
            filterTitleEl,
            filterSummaryEl,
            filterGmEl,
            filterCharacterEl,
            filterTagsEl,
            filterStageNamesEl,
            filterTagModeEl,
            filterYearFromEl,
            filterYearToEl,
            filterMonthFromEl,
            filterMonthToEl
          ].forEach((control) => {
            control.addEventListener('input', () => {
              updateFiltersFromControls();
              render();
            });
            control.addEventListener('change', () => {
              updateFiltersFromControls();
              render();
            });
          });

          toggleAdvancedBtn.addEventListener('click', () => {
            const willOpen = advancedPanel.classList.contains('hidden');
            advancedPanel.classList.toggle('hidden');
            toggleAdvancedBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          });

          clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            keyword = '';
            filterTitleEl.value = '';
            filterSummaryEl.value = '';
            filterGmEl.value = '';
            filterCharacterEl.value = '';
            filterTagsEl.value = '';
            filterStageNamesEl.value = '';
            filterTagModeEl.value = 'or';
            filterYearFromEl.value = '';
            filterYearToEl.value = '';
            filterMonthFromEl.value = '';
            filterMonthToEl.value = '';
            updateFiltersFromControls();
            render();
          });

          document.addEventListener('click', (event) => {
            if (!event.target.closest('.connection-hit-target') && !event.target.closest('#connection-tooltip')) {
              if (typeof hideTooltip === 'function') hideTooltip();
            }
          });

            updateFiltersFromControls();
            render();
          } catch (error) {
            const message = '描画中にエラーが発生しました: ' + (error && error.message ? error.message : 'unknown');
            timelineEl.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
            detailEl.innerHTML = '<div class="empty">' + escapeHtml(message) + '</div>';
          }
        }

        main();
      })();
    </script>
  </body>
</html>`;

  downloadFile(filename, html, 'text/html;charset=utf-8');
});

initializeFilters(applyFiltersAndRender);
