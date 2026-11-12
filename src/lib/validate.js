import { z } from 'zod';
import { badRequest } from './errors.js';

export { z };

export function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('Datos inválidos', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const uuid = z.uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato AAAA-MM-DD');
export const shortText = (max = 200) => z.string().trim().min(1).max(max);
export const optText = (max = 2000) => z.string().trim().max(max).optional().nullable();
export const strList = (maxItems = 30, maxLen = 200) => z.array(z.string().trim().min(1).max(maxLen)).max(maxItems);
export const password = z.string().min(10, 'La contraseña debe tener al menos 10 caracteres').max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /\d/.test(p), 'La contraseña debe incluir letras y números');
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
