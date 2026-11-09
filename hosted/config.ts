export function validateDatabaseUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid hosted database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.searchParams.getAll('sslmode').length !== 1 || url.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Hosted database URL must use sslmode=verify-full');
  }
}

export function validateHostedBuild(html: string) {
  if (!html.includes('<meta name="coinjar-hosted-build" content="true"')) throw new Error('Hosted server requires a tracking-only hosted build');
}
