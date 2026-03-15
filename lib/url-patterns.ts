const authLikePattern = /(login|auth|signin|signup|verify|captcha|password|account|oauth|session|mfa|2fa|risk|bridge|worker|service-worker|runtime)/i;
const lowSignalPattern = /(search|result|recommend|goods|product|offer|banner|popup|widget|download|slider|carousel|privacy|cookie)/i;

export function isAuthLikePathname(pathname: string): boolean {
  return authLikePattern.test(pathname);
}

export function isLowSignalPathname(pathname: string): boolean {
  return lowSignalPattern.test(pathname);
}

export function extractPathTokens(pathname: string): string[] {
  return pathname
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 3);
}
