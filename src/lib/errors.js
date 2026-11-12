export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || 'error';
    this.details = details;
  }
}
export const badRequest = (msg, details) => new HttpError(400, msg, 'bad_request', details);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'No tienes permiso para esta acción') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Recurso no encontrado') => new HttpError(404, msg, 'not_found');
export const conflict = (msg, code = 'conflict', details) => new HttpError(409, msg, code, details);
export const unprocessable = (msg, code = 'unprocessable', details) => new HttpError(422, msg, code, details);
export const tooMany = (msg, code = 'limit_reached', details) => new HttpError(429, msg, code, details);
export const unavailable = (msg, code = 'unavailable') => new HttpError(503, msg, code);
