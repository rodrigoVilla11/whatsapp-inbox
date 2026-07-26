/** Debounce simple y testeable (la búsqueda de la lista usa 300ms). */

export const SEARCH_DEBOUNCE_MS = 300;

export interface Debounced<A extends unknown[]> {
  call(...args: A): void;
  cancel(): void;
}

export function createDebounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call(...args: A) {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn(...args);
      }, ms);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
