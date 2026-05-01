function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function parseJsonOrNull(response, path = "") {
  try {
    return path ? response.json(path) : response.json();
  } catch (_err) {
    return null;
  }
}

export { parseJsonOrNull, randomInt };