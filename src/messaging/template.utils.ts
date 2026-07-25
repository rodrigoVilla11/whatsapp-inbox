/**
 * Cantidad de variables de una plantilla = el MAYOR índice {{n}} del body
 * (no la cantidad de apariciones: {{1}} repetido sigue siendo 1 variable).
 */
export function countTemplateVariables(bodyText: string): number {
  let max = 0;
  for (const match of bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/** Renderiza {{n}} → params[n-1], para body del Message y preview. */
export function renderTemplateBody(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, index: string) => {
    return params[Number(index) - 1] ?? '';
  });
}
