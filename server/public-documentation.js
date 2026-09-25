import { openapi } from './openapi.js';

// Deliberately derived only from public source: never read local project notes.
export function publicDocumentation() {
  const operations = Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method))
      .map(([method, operation]) => `- ${method.toUpperCase()} ${path}: ${operation.summary || operation.operationId || ''}`),
  );
  return [
    '# Anonyma',
    '',
    'Prepaid AI workspace. Check /api/config and /roadmap for current feature availability.',
    'The contract below includes implemented but unreleased features; it does not establish live access. Unreleased endpoints return feature_unreleased.',
    'Machine-readable API contract: /api/openapi.json',
    'Interactive product documentation: /docs',
    'API requests use a Bearer API key; browser sessions use a protected cookie.',
    'Live generation, payment and email require operator-configured services.',
    'Use a unique Idempotency-Key for each logical paid chat request.',
    'Local test mode uses isolated fixtures and must not be used for live funds.',
    '',
    '## API operations',
    ...operations,
    '',
  ].join('\n');
}
