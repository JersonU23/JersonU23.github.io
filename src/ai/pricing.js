// Precios por millón de tokens (USD), tarifas de la API de Anthropic vigentes al implementar.
// IMPORTANTE: los precios cambian. El administrador puede sobrescribirlos en Configuración → IA,
// y cada solicitud guarda una copia (price_snapshot) del precio con el que se calculó su costo.
export const DEFAULT_PRICING = {
  'claude-opus-5-5': { input: 4, output: 20, cache_write: 5, cache_read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cache_write: 2.5, cache_read: 0.1 },
  // Haiku 5.5: tarifa para prompts de hasta 100K tokens. cache_read pendiente de verificar en la página oficial de precios.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cache_write: 0.125, cache_read: 0.01 },
  // Modelos a los que el proveedor puede redirigir mediante "fallbacks" si el principal rechaza la solicitud
  'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 },
};

export const SUPPORTED_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export function priceFor(model, overrides = {}) {
  return overrides[model] || DEFAULT_PRICING[model] || null;
}

export function computeCost(usage, price) {
  if (!price) return 0;
  const cost = ((usage.input_tokens || 0) * price.input
    + (usage.output_tokens || 0) * price.output
    + (usage.cache_creation_input_tokens || 0) * price.cache_write
    + (usage.cache_read_input_tokens || 0) * price.cache_read) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}
