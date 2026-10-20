import { getRole } from "./state.js";
import { onTextHandedOff } from "./textSync.js";

/**
 * Escapes HTML characters to prevent XSS.
 */
export function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Extracts a normalized, valid web URL from arbitrary text.
 * Returns { url, hostname, displayUrl } or null if no valid URL is found.
 */
export function extractUrl(text) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 1. Explicit http/https URL anywhere in the text
  const explicitMatch = trimmed.match(/https?:\/\/[^\s<>"'{}|\\^`]+/i);
  if (explicitMatch) {
    const raw = explicitMatch[0].replace(/[.,!?:;)\]]+$/, "");
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return {
          url: parsed.href,
          hostname: parsed.hostname,
          displayUrl: parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "") + parsed.search
        };
      }
    } catch (_) {}
  }

  // 2. Starts with www.
  const wwwMatch = trimmed.match(/\bwww\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"'{}|\\^`]*/i);
  if (wwwMatch) {
    const raw = wwwMatch[0].replace(/[.,!?:;)\]]+$/, "");
    try {
      const parsed = new URL(`https://${raw}`);
      if (parsed.protocol === "https:") {
        return {
          url: parsed.href,
          hostname: parsed.hostname,
          displayUrl: parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "") + parsed.search
        };
      }
    } catch (_) {}
  }

  // 3. Domain pattern without protocol (e.g. "github.com" or "news.ycombinator.com/item?id=1")
  const fileExts = /\.(txt|pdf|png|jpe?g|gif|zip|tar|gz|json|csv|md|docx?|xlsx?|pptx?|mp3|mp4|svg|iso|dmg|exe)$/i;
  const singleDomainMatch = trimmed.match(/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(\/[^\s]*)?$/);
  if (singleDomainMatch && !fileExts.test(trimmed.split("/")[0])) {
    try {
      const parsed = new URL(`https://${trimmed}`);
      if (parsed.hostname.includes(".")) {
        return {
          url: parsed.href,
          hostname: parsed.hostname,
          displayUrl: parsed.hostname + (parsed.pathname !== "/" ? parsed.pathname : "") + parsed.search
        };
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Transforms text containing URLs into safe HTML with styled, clickable <a> links.
 */
export function linkifyText(text) {
  if (!text || typeof text !== "string") return "";

  const urlRegex = /(https?:\/\/[^\s<>"'{}|\\^`]+|\bwww\.[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s<>"'{}|\\^`]*)/gi;

  let lastIndex = 0;
  let html = "";
  let match;

  while ((match = urlRegex.exec(text)) !== null) {
    const matchedUrl = match[0];
    const matchIndex = match.index;

    // Append safe text before the matched URL
    html += escapeHtml(text.slice(lastIndex, matchIndex));

    // Separate trailing punctuation so it doesn't break the URL
    const trailingPunct = matchedUrl.match(/[.,!?:;)\]]+$/);
    const cleanUrl = trailingPunct ? matchedUrl.slice(0, -trailingPunct[0].length) : matchedUrl;
    const punctStr = trailingPunct ? trailingPunct[0] : "";

    const normalizedHref = cleanUrl.toLowerCase().startsWith("www.")
      ? `https://${cleanUrl}`
      : cleanUrl;

    html += `<a href="${escapeHtml(normalizedHref)}" class="text-link" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanUrl)}</a>${escapeHtml(punctStr)}`;

    lastIndex = matchIndex + matchedUrl.length;
  }

  html += escapeHtml(text.slice(lastIndex));

  // If no explicit http://, https://, or www. matched, check if the entire trimmed string is a standalone domain
  if (!html.includes("<a href=")) {
    const trimmed = text.trim();
    const fileExts = /\.(txt|pdf|png|jpe?g|gif|zip|tar|gz|json|csv|md|docx?|xlsx?|pptx?|mp3|mp4|svg|iso|dmg|exe)$/i;
    const domainMatch = trimmed.match(/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(\/[^\s]*)?$/);
    if (domainMatch && !fileExts.test(trimmed.split("/")[0])) {
      const normalizedHref = `https://${trimmed}`;
      return `<a href="${escapeHtml(normalizedHref)}" class="text-link" target="_blank" rel="noopener noreferrer">${escapeHtml(trimmed)}</a>`;
    }
  }

  return html;
}

/**
 * Safely opens a validated URL in a new tab without popup blocker interference.
 */
export function openUrlInNewTab(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn("Blocked unsafe URL protocol:", parsed.protocol);
      return false;
    }
    // Note: When noopener/noreferrer is set, window.open returns null per HTML specification.
    // Executing window.open without throwing is the indicator of success.
    window.open(parsed.href, "_blank", "noopener,noreferrer");
    return true;
  } catch (err) {
    console.warn("Failed to open URL in new tab:", err);
  }
  return false;
}

/**
 * Updates the text display overlay for a given role based on whether text contains a link.
 */
export function updateUrlOpenerUI({ role = getRole(), text = "" } = {}) {
  const isComputer = role === "computer";
  const textarea = document.getElementById(isComputer ? "desktop-text" : "phone-text");
  const display = document.getElementById(isComputer ? "desktop-text-display" : "phone-text-display");

  if (!display) return null;

  const urlData = extractUrl(text);

  if (!urlData || !text.trim()) {
    display.innerHTML = "";
    display.classList.add("hidden");
    return null;
  }

  display.innerHTML = linkifyText(text);

  // If user is actively typing in the textarea, keep overlay hidden so editing isn't interrupted
  if (document.activeElement === textarea) {
    display.classList.add("hidden");
  } else {
    display.classList.remove("hidden");
  }

  return urlData;
}

/**
 * Programmatically triggers the open action for the given role:
 * Opens the URL in a new browser tab and triggers the text handoff completion.
 */
export function handleOpenUrlAction(targetRole = getRole()) {
  const isComputer = targetRole === "computer";
  const textarea = document.getElementById(isComputer ? "desktop-text" : "phone-text");
  const urlData = extractUrl(textarea?.value || "");

  if (!urlData) return false;

  const opened = openUrlInNewTab(urlData.url);
  if (opened) {
    onTextHandedOff({ action: "opened", role: targetRole, delayMs: 300 });
    return true;
  }
  return false;
}

/**
 * Binds event listeners for Instant URL links and text-display interaction.
 */
export function setupInstantUrlListeners() {
  const roles = [
    { role: "computer", textId: "desktop-text", displayId: "desktop-text-display" },
    { role: "phone", textId: "phone-text", displayId: "phone-text-display" }
  ];

  roles.forEach(({ role, textId, displayId }) => {
    const textarea = document.getElementById(textId);
    const display = document.getElementById(displayId);

    if (!textarea || !display) return;

    // Clicking inside the display overlay:
    // If clicking a link -> open the link & hand off text
    // If clicking non-link area -> focus textarea for editing
    display.addEventListener("click", (e) => {
      const link = e.target.closest(".text-link");
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute("href");
        if (href) {
          const opened = openUrlInNewTab(href);
          if (opened) {
            onTextHandedOff({ action: "opened", role, delayMs: 300 });
          }
        }
        return;
      }

      // User clicked outside the link: switch to edit mode
      display.classList.add("hidden");
      textarea.scrollTop = display.scrollTop;
      textarea.focus();
    });

    // When textarea is focused, hide the overlay so the user can edit raw text
    textarea.addEventListener("focus", () => {
      display.classList.add("hidden");
    });

    // When textarea is blurred, if there is a URL, show the linkified overlay
    textarea.addEventListener("blur", () => {
      const content = textarea.value || "";
      if (extractUrl(content)) {
        display.innerHTML = linkifyText(content);
        display.scrollTop = textarea.scrollTop;
        display.classList.remove("hidden");
      } else {
        display.classList.add("hidden");
      }
    });

    // Keyboard shortcuts in textarea
    textarea.addEventListener("keydown", (e) => {
      // Escape blurs the textarea, showing the linkified overlay if URL exists
      if (e.key === "Escape") {
        textarea.blur();
        return;
      }

      // Cmd+Enter or Ctrl+Enter in textarea opens the link immediately
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const urlData = extractUrl(textarea.value || "");
        if (urlData) {
          e.preventDefault();
          const opened = openUrlInNewTab(urlData.url);
          if (opened) {
            onTextHandedOff({ action: "opened", role, delayMs: 300 });
          }
        }
      }
    });
  });
}
