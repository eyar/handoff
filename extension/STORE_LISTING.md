# Chrome Web Store / Edge Add-ons listing (draft)

## Name
Handoff — Send to Phone

## Summary (≤ 132 characters)
Send text, links, images and files between Chrome and your phone. Scan a QR code — no app, no account, end-to-end encrypted.

## Category
Productivity

## Description
Move things between your computer and your phone in one click — iPhone or Android, Windows or Mac.

• Right-click any text, link, image or page → "Send to phone"
• Click the toolbar icon (or press Alt+Shift+H) to open Handoff in the side panel
• Scan the QR code with your phone's camera once — no app to install, no account
• Drag files into the panel to send them; files from your phone appear there to download or copy
• Text and files are end-to-end encrypted (AES-256-GCM) in your browser
• Nothing is kept: files are deleted after 15 minutes, text after 60 seconds
• Files up to 1.5 GB, free

The perfect "AirDrop for Windows" — and it works just as well on Mac, Linux and ChromeOS.

Open source: https://github.com/eyar/handoff

## Single purpose
Send text, links, images and files from the browser to the user's own paired phone (and receive files back) using Handoff.

## Permission justifications
- **sidePanel** — Shows the Handoff app (QR pairing, transfers) in Chrome's side panel.
- **contextMenus** — Adds "Send … to phone" to the right-click menu for selected text, links, images and pages.
- **storage** — Holds items the user chose to send for a moment, until the side panel delivers them (session storage only, cleared when the browser closes).
- **scripting + activeTab** — When the user right-clicks an image and chooses "Send image to phone", reads that one image from the current tab so it can be sent as a file. Only runs on that click, on that tab.
- **Host permission handoffdrop.app** — The side panel embeds the Handoff web app from handoffdrop.app.

## Privacy practices
- The extension does not include its own analytics or advertising trackers and does not sell user data. The Handoff website uses Cloudflare Analytics for aggregate traffic and performance measurements (such as page views, page path/referrer, device/browser, approximate country, and page-load metrics); it is not used for advertising or individual profiling.
- Content the user explicitly sends is end-to-end encrypted in the browser (up to 100 MB) and relayed via Handoff's servers only to the user's paired device; files are deleted after 15 minutes, text after 60 seconds.
- Privacy policy: https://handoffdrop.app/privacy.html

## Assets needed
- Icon 128×128 (extension/icons/icon-128.png)
- At least 1 screenshot 1280×800 (side panel with QR; right-click menu; file arriving on phone)
- Small promo tile 440×280 (optional)
