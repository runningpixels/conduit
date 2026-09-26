import { describe, expect, it } from 'vitest';
import { declaredHosts, hostLabel, scriptedHosts } from './networkHosts';

describe('declaredHosts', () => {
  it('reads each declared site with its reason', () => {
    const html = `<head>
      <meta name="conduit-network" content="api.open-meteo.com — live weather for the chosen city">
      <meta content='https://geocoding-api.open-meteo.com: find the city' name='conduit-network'>
    </head>`;
    expect(declaredHosts(html)).toEqual([
      { origin: 'https://api.open-meteo.com', reason: 'live weather for the chosen city' },
      { origin: 'https://geocoding-api.open-meteo.com', reason: 'find the city' },
    ]);
  });

  it('splits several sites in one tag and keeps the first reason', () => {
    const html = `<meta name="conduit-network" content="a.example.com - one; b.example.com; a.example.com - again">`;
    expect(declaredHosts(html)).toEqual([
      { origin: 'https://a.example.com', reason: 'one' },
      { origin: 'https://b.example.com', reason: undefined },
    ]);
  });

  it('ignores other meta tags and non-https declarations', () => {
    const html = `<meta name="description" content="api.example.com — no">
      <meta name="conduit-network" content="http://plain.example.com — insecure">`;
    expect(declaredHosts(html)).toEqual([]);
  });
});

describe('scriptedHosts', () => {
  it('finds https origins in scripts only, skipping namespace hosts', () => {
    const html = `<a href="https://docs.example.com">docs</a>
      <svg xmlns="http://www.w3.org/2000/svg"></svg>
      <script>
        const url = 'https://api.github.com/repos/x';
        document.createElementNS('https://www.w3.org/2000/svg', 'g');
        fetch(\`https://api.open-meteo.com/v1/forecast?x=\${1}\`);
      </script>`;
    expect(scriptedHosts(html)).toEqual(['https://api.github.com', 'https://api.open-meteo.com']);
  });
});

describe('hostLabel', () => {
  it('shows the host, with a port only when it is not the default', () => {
    expect(hostLabel('https://api.example.com')).toBe('api.example.com');
    expect(hostLabel('https://api.example.com:8443')).toBe('api.example.com:8443');
  });
});
