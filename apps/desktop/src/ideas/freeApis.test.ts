import { describe, expect, it } from 'vitest';
import { requestOrigin } from '../artifacts/networkBridge';
import { declaredHosts } from '../artifacts/networkHosts';
import { SHIPPED_LOCALE_CODES } from '../i18n/locales';
import { IDEAS } from './catalog';
import { FREE_APIS, freeApiById, freeApiGivesKey, freeApiLimitMessage } from './freeApis';

import de from '../i18n/messages/de.json';
import enMessages from '../i18n/messages/en.json';
import es from '../i18n/messages/es.json';
import fr from '../i18n/messages/fr.json';
import ja from '../i18n/messages/ja.json';
import ko from '../i18n/messages/ko.json';
import ptBR from '../i18n/messages/pt-BR.json';
import zhCN from '../i18n/messages/zh-CN.json';

const catalogs: Record<string, Record<string, string>> = {
  en: enMessages,
  de,
  es,
  fr,
  ja,
  ko,
  'pt-BR': ptBR,
  'zh-CN': zhCN,
};
const catalogFor = (locale: string) => {
  const catalog = catalogs[locale];
  if (!catalog) throw new Error(`no catalog imported for ${locale}`);
  return catalog;
};
const en = catalogFor('en');
const translated = SHIPPED_LOCALE_CODES.filter((code) => code !== 'en');

const apiIdeas = IDEAS.filter((idea) => (idea.apis ?? []).length > 0);

describe('free API catalogue', () => {
  it('has unique ids and complete, https entries', () => {
    expect(new Set(FREE_APIS.map((a) => a.id)).size).toBe(FREE_APIS.length);
    for (const api of FREE_APIS) {
      expect(api.name.trim(), api.id).toBeTruthy();
      for (const url of [api.homepage, api.docs, api.example]) expect(url, api.id).toMatch(/^https:\/\//);
      expect(api.hosts.length, api.id).toBeGreaterThan(0);
      expect(api.verified.on, api.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (api.limits) {
        expect(api.limits.requests, api.id).toBeGreaterThan(0);
        expect(api.limits.perSeconds, api.id).toBeGreaterThan(0);
      }
    }
  });

  it("lists every host as a page would declare it, the example's host included", () => {
    for (const api of FREE_APIS) {
      for (const host of api.hosts) {
        // A bare host name, which <meta name="conduit-network"> reads back as its https origin.
        expect(host, api.id).toMatch(/^[a-z0-9.-]+$/);
        const [declared] = declaredHosts(`<meta name="conduit-network" content="${host} — data">`);
        expect(declared?.origin, `${api.id}: ${host}`).toBe(`https://${host}`);
      }
      const origin = requestOrigin(api.example);
      expect(origin, api.id).toBe(new URL(api.example).origin);
      expect(api.hosts, api.id).toContain(new URL(api.example).hostname);
    }
  });

  it('is used by at least one idea, and every idea names known APIs', () => {
    const used = new Set(apiIdeas.flatMap((idea) => idea.apis ?? []));
    for (const api of FREE_APIS) expect(used.has(api.id), `${api.id} has no idea`).toBe(true);
    for (const idea of apiIdeas) {
      for (const id of idea.apis ?? []) expect(freeApiById(id), `${idea.id}: ${id}`).toBeDefined();
    }
  });

  it('gates every API idea on network access, as a page', () => {
    for (const idea of apiIdeas) {
      expect(idea.needs, idea.id).toContain('network');
      expect(idea.page, idea.id).toBe(true);
    }
    // And every live-data idea says which API it uses.
    for (const idea of IDEAS.filter((i) => i.needs.includes('network'))) {
      expect(idea.apis?.length ?? 0, idea.id).toBeGreaterThan(0);
    }
  });

  it("names each API's host in the idea's prompt, in every language", () => {
    for (const locale of ['en', ...translated]) {
      const messages = catalogFor(locale);
      for (const idea of apiIdeas) {
        const prompt = messages[`ideas.item.${idea.id}.prompt`];
        for (const id of idea.apis ?? []) {
          const host = freeApiById(id)!.hosts[0];
          expect(prompt, `${locale}/${idea.id} should name ${host}`).toContain(host);
        }
      }
    }
  });

  it('has its strings in every locale', () => {
    const keys = [
      ...FREE_APIS.map(freeApiGivesKey),
      ...FREE_APIS.map((api) => freeApiLimitMessage(api).key),
      'ideas.api.label',
      'ideas.sheet.tab.apis',
      'ideas.apis.heading',
      'ideas.apis.intro',
      'ideas.apis.docs',
      'ideas.apis.docsAriaLabel',
      'ideas.apis.tryAriaLabel',
      'ideas.apis.idea',
      'ideas.apis.credit',
      ...apiIdeas.flatMap((idea) => ['title', 'blurb', 'prompt'].map((p) => `ideas.item.${idea.id}.${p}`)),
    ];
    for (const locale of ['en', ...translated]) {
      const messages = catalogFor(locale);
      for (const key of keys) expect(messages[key], `${locale}: ${key}`).toBeTruthy();
    }
    expect(en['ideas.api.limit.seeDocs']).toBeTruthy();
  });

  it('words a limit by its window', () => {
    expect(freeApiLimitMessage({ limits: { requests: 60, perSeconds: 3600 } })).toEqual({
      key: 'ideas.api.limit.hour',
      values: { count: 60 },
    });
    expect(freeApiLimitMessage({ limits: { requests: 1, perSeconds: 5 } })).toEqual({
      key: 'ideas.api.limit.seconds',
      values: { count: 1, seconds: 5 },
    });
    expect(freeApiLimitMessage({})).toEqual({ key: 'ideas.api.limit.seeDocs' });
  });
});
