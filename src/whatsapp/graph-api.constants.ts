/**
 * Versión de Graph API, fijada — NUNCA flotante, NUNCA hardcodeada en URLs.
 * Todos los llamados a Meta construyen la URL desde acá.
 * MetaApp.graphVersion permite override por app si hiciera falta.
 */
export const GRAPH_API_VERSION = 'vXX.X'; // TODO confirmar contra el changelog de Meta antes del primer llamado real

export const graphApiBaseUrl = (version: string = GRAPH_API_VERSION): string =>
  `https://graph.facebook.com/${version}`;
