// The same components, rendered to HTML at build time. Everything a reader sees has to exist in the file a
// crawler downloads: the page is about an editorial engine, and it could not be read by one.
import { renderToString } from "react-dom/server";
import App from "./App";
import { PrivacyPage, TermsPage, CookiesPage, AboutPage } from "./Legal";

export function render() {
  return renderToString(<App />);
}

export function renderPrivacy() {
  return renderToString(<PrivacyPage />);
}

export function renderTerms() {
  return renderToString(<TermsPage />);
}

export function renderCookies() {
  return renderToString(<CookiesPage />);
}

export function renderAbout() {
  return renderToString(<AboutPage />);
}
