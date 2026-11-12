// Proveedor de IA: Anthropic (Claude). Toda llamada a IA pasa por aquí y devuelve JSON validado por esquema.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export class AIProviderError extends Error {
  constructor(message, { kind = 'provider_error', usage = null, model = null } = {}) {
    super(message);
    this.kind = kind;
    this.usage = usage;
    this.model = model;
  }
}

export class AnthropicProvider {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }

  /**
   * Genera una respuesta JSON que cumple `schema` (salida estructurada).
   * El prompt de sistema (estable) se marca para caché; el contenido variable va en el mensaje del usuario.
   */
  async generateJson({ model, effort, system, user, schema, maxTokens = 32000 }) {
    let message;
    try {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: maxTokens,
        // Si el modelo rechaza por políticas, el servidor reintenta en el modelo recomendado.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { effort, format: { type: 'json_schema', schema } },
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw new AIProviderError('Clave de API de IA inválida', { kind: 'auth' });
      if (err instanceof Anthropic.RateLimitError) throw new AIProviderError('El proveedor de IA limitó la solicitud; reintenta más tarde', { kind: 'rate_limit' });
      if (err instanceof Anthropic.BadRequestError) throw new AIProviderError(`Solicitud rechazada por el proveedor: ${err.message}`, { kind: 'bad_request' });
      if (err instanceof Anthropic.APIError) throw new AIProviderError(`Error del proveedor de IA (${err.status ?? 'red'}): ${err.message}`);
      throw new AIProviderError(`Error de conexión con el proveedor de IA: ${err.message}`);
    }
    const usage = message.usage || {};
    if (message.stop_reason === 'refusal') {
      throw new AIProviderError('El modelo declinó la solicitud', { kind: 'refusal', usage, model: message.model });
    }
    if (message.stop_reason === 'max_tokens') {
      throw new AIProviderError('La respuesta de IA se truncó (límite de tokens)', { kind: 'truncated', usage, model: message.model });
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AIProviderError('La IA devolvió un JSON inválido', { kind: 'invalid_output', usage, model: message.model });
    }
    return { json, usage, model: message.model };
  }
}

// Inyección del proveedor (permite sustituirlo en pruebas automatizadas).
let provider = config.anthropicApiKey ? new AnthropicProvider(config.anthropicApiKey) : null;
export const getProvider = () => provider;
export const setProvider = (p) => { provider = p; };
