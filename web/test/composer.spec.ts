import { describe, expect, it } from 'vitest';
import {
  manualRetry,
  nextNetworkAttempt,
  onDomainFailure,
  onNetworkError,
  shouldAutoRetry,
  startSend,
} from '../src/lib/composer';

let n = 0;
const gen = (): string => `key-${++n}`;

describe('máquina de estados del envío (contrato fases 4/6)', () => {
  it('startSend genera key nueva y attempts 1', () => {
    const entry = startSend(gen);
    expect(entry).toMatchObject({ attempts: 1, status: 'sending' });
    expect(entry.clientDedupKey).toMatch(/^key-/);
  });

  it('fallo de red → UN auto-retry con la MISMA key', () => {
    const first = startSend(gen);
    const failed = onNetworkError(first);
    expect(shouldAutoRetry(failed)).toBe(true);

    const retry = nextNetworkAttempt(failed);
    expect(retry.clientDedupKey).toBe(first.clientDedupKey); // MISMA key
    expect(retry.attempts).toBe(2);

    const failedAgain = onNetworkError(retry);
    expect(shouldAutoRetry(failedAgain)).toBe(false); // no más auto-retry
    expect(failedAgain.status).toBe('failed-network');
  });

  it('retry MANUAL tras fallo de red → sigue la MISMA key (nunca hubo FAILED del server)', () => {
    const entry = onNetworkError(nextNetworkAttempt(onNetworkError(startSend(gen))));
    const retried = manualRetry(entry, gen);
    expect(retried.clientDedupKey).toBe(entry.clientDedupKey);
    expect(retried.status).toBe('sending');
  });

  it('FAILED del servidor → retry manual con key NUEVA (envío nuevo por decisión humana)', () => {
    const entry = startSend(gen);
    const domainFailed = onDomainFailure(entry);
    expect(domainFailed.status).toBe('failed-domain');

    const retried = manualRetry(domainFailed, gen);
    expect(retried.clientDedupKey).not.toBe(entry.clientDedupKey); // key NUEVA
    expect(retried).toMatchObject({ attempts: 1, status: 'sending' });
  });

  it('secuencia completa: PENDING → replay misma key → FAILED → retry key nueva', () => {
    const a = startSend(gen); // intento 1
    const b = nextNetworkAttempt(onNetworkError(a)); // replay de red: misma key
    expect(b.clientDedupKey).toBe(a.clientDedupKey);

    const c = onDomainFailure(b); // el server persistió FAILED
    const d = manualRetry(c, gen); // decisión humana
    expect(d.clientDedupKey).not.toBe(a.clientDedupKey);
  });
});
