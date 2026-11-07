/**
 * Text direction from the tenant's locale. `Intl.Locale.maximize()` fills in the
 * likely script for a bare language code, so one list of right-to-left ISO 15924
 * scripts covers every language, and an explicit script subtag wins.
 *
 * The engine keeps the same rule in src/publishing/text-direction.ts; this
 * package deploys on its own and cannot import across that boundary.
 */

const RTL_SCRIPTS = new Set([
  'Adlm', 'Arab', 'Aran', 'Armi', 'Avst', 'Chrs', 'Cprt', 'Elym', 'Hatr', 'Hebr',
  'Hung', 'Khar', 'Lydi', 'Mand', 'Mani', 'Mend', 'Merc', 'Mero', 'Narb', 'Nbat',
  'Nkoo', 'Orkh', 'Palm', 'Phli', 'Phlp', 'Phnx', 'Prti', 'Rohg', 'Samr', 'Sarb',
  'Sogd', 'Sogo', 'Syrc', 'Thaa', 'Yezi',
]);

export function textDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const { script } = new Intl.Locale(locale.trim()).maximize();
    return script && RTL_SCRIPTS.has(script) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}
