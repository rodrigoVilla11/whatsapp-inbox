/**
 * Ref de la MetaApp que atiende las rutas sin :ref explícito
 * (/webhooks/whatsapp). Es la app única del modelo Tech Provider;
 * el seed la crea con este ref.
 */
export const DEFAULT_META_APP_REF = 'default';

/** Prefijo de ruta que recibe body crudo (ver configureBodyParsers). */
export const WEBHOOKS_PATH = '/webhooks';
