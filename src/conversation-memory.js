function uniqueNumbers(values = []) {
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value <= 5000))];
}

export function extractBandText(message = "") {
  const matches = [...String(message).matchAll(/(\d+(?:\.\d+)?)\s*(?:-|–|~|到)\s*(\d+(?:\.\d+)?)/g)];
  return matches.length ? matches.map((match) => `${match[1]}-${match[2]}`).join(";") : "";
}

export function extractTemperatureText(message = "", { expectsTemperature = false } = {}) {
  const text = String(message ?? "").trim();
  const explicitUnit = text.match(/(\d+(?:\.\d+)?(?:\s*[，,;；]\s*\d+(?:\.\d+)?)*?)\s*(?:k\b|开尔文)/i);
  const explicitLabel = text.match(/(?:黑体)?温度\s*(?:是|为|设为|设置为|用|取|选择)?\s*[：:]?\s*(\d+(?:\.\d+)?(?:\s*[，,;；]\s*\d+(?:\.\d+)?)*)/i);
  const explicit = explicitUnit?.[1] || explicitLabel?.[1] || "";
  if (explicit) return uniqueNumbers(explicit.split(/[，,;；]/)).join(",");
  if (!expectsTemperature) return "";

  // 上一轮明确在询问温度时，允许用户自然地只回答“300”或“就 300，不用其他温度”。
  // 先移除波段，避免把“3-5”误记成 3 K、5 K。
  const withoutBands = text.replace(/\d+(?:\.\d+)?\s*(?:-|–|~|到)\s*\d+(?:\.\d+)?/g, " ");
  const values = uniqueNumbers([...withoutBands.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]));
  return values.join(",");
}

export function mergeCalculationRequirements(current = {}, message = "", context = {}) {
  const next = {
    bandText: String(current.bandText ?? ""),
    temperatureKelvin: String(current.temperatureKelvin ?? ""),
    temperatureText: String(current.temperatureText ?? ""),
  };
  const bandText = extractBandText(message);
  if (bandText) next.bandText = bandText;
  const expectsTemperature = Boolean(context.expectsTemperature || (context.hasBlackbodySource && next.bandText && !next.temperatureText && !next.temperatureKelvin));
  const temperatureText = extractTemperatureText(message, { expectsTemperature });
  if (temperatureText) {
    next.temperatureText = temperatureText;
    next.temperatureKelvin = temperatureText.split(",")[0];
  }
  return next;
}

export function rebuildCalculationRequirements(current = {}, messages = [], context = {}) {
  return messages.reduce((state, message) => mergeCalculationRequirements(state, message, {
    ...context,
    expectsTemperature: Boolean(context.hasBlackbodySource && state.bandText && !state.temperatureText && !state.temperatureKelvin),
  }), current);
}

export function applyStructuredContextUpdate(current = {}, update = {}) {
  const next = {
    bandText: String(current.bandText ?? ""),
    temperatureKelvin: String(current.temperatureKelvin ?? ""),
    temperatureText: String(current.temperatureText ?? ""),
  };
  if (Array.isArray(update.bandsMicron)) {
    const bands = update.bandsMicron.map((band) => ({ min: Number(band?.min), max: Number(band?.max) }))
      .filter((band) => Number.isFinite(band.min) && Number.isFinite(band.max) && band.min >= 0 && band.max <= 100000 && band.min < band.max)
      .slice(0, 12);
    if (bands.length) next.bandText = bands.map((band) => `${band.min}-${band.max}`).join(";");
  }
  if (Array.isArray(update.temperaturesKelvin)) {
    const temperatures = uniqueNumbers(update.temperaturesKelvin).slice(0, 12);
    if (temperatures.length) {
      next.temperatureText = temperatures.join(",");
      next.temperatureKelvin = String(temperatures[0]);
    }
  }
  return next;
}
