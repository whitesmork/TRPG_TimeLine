export function getSelectedScenario(visibleScenarios, selectedScenarioId) {
  return visibleScenarios.find((scenario) => scenario.id === selectedScenarioId) || visibleScenarios[0] || null;
}

export function getScenarioDateSortValue(scenario) {
  return scenario.year * 12 + scenario.month;
}
