export function groupScenariosByMonth(scenarios) {
  const monthMap = new Map();
  scenarios.forEach((scenario) => {
    const key = `${scenario.year}-${scenario.month}`;
    if (!monthMap.has(key)) monthMap.set(key, []);
    monthMap.get(key).push(scenario);
  });
  return monthMap;
}

export function sortMonthKeys(monthKeys) {
  return [...monthKeys].sort((a, b) => {
    const [yearA, monthA] = a.split('-').map(Number);
    const [yearB, monthB] = b.split('-').map(Number);
    return yearA * 12 + monthA - (yearB * 12 + monthB);
  });
}
