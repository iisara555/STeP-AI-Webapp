const DISABLED = new Map([
  ['@github/copilot-sdk', new URL('./disabled/copilot-sdk.mjs', import.meta.url).href],
]);

export async function resolve(specifier, context, next) {
  const replacement = DISABLED.get(specifier);
  return replacement ? { url: replacement, shortCircuit: true } : next(specifier, context);
}
