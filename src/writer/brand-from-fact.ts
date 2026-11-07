import { SITE_NAME } from "../config/domain.js";

/**
 * The business name to count and demote. SITE_NAME wins when the fact uses it;
 * otherwise the first all-caps Latin token — but never a product word. For an
 * LED company "LED" is the product, and demoting it turned "LED screens" into
 * "the company screens".
 */
const PRODUCT_TOKENS = new Set(["LED", "LCD", "OLED", "AV", "VMS", "QR", "DOOH", "SMD", "USB", "HDMI", "AI", "SEO"]);
export function brandFromFact(fact: string, siteName: string = SITE_NAME ?? ""): string {
  const name = siteName.trim();
  if (name && fact.includes(name)) return name;
  for (const match of fact.matchAll(/[A-Z][A-Z-]{2,}/g)) {
    if (!PRODUCT_TOKENS.has(match[0])) return match[0];
  }
  return "";
}
