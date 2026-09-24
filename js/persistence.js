export function downloadFile(filename, data, contentType) {
  const blob = new Blob([data], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createJsonPayload(tags, scenarios) {
  return JSON.stringify({ tags, scenarios }, null, 2);
}
