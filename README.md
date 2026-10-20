# 🚀 Handoff

> **Fast, private, zero-install file and text transfer across any device.**  
> An open-source, web-based AirDrop alternative that just works.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)
[![Architecture: Vanilla ESM](https://img.shields.io/badge/Architecture-Zero%20Bundler%20ESM-orange.svg)]()
[![Security: Client-Side E2EE](https://img.shields.io/badge/Security-Client--side%20E2EE%20(AES--GCM)-success.svg)]()
[![Live App](https://img.shields.io/badge/Live-handoffdrop.app-blueviolet.svg)](https://handoffdrop.app)

---

### [👉 Try Handoff Live (handoffdrop.app)](https://handoffdrop.app)

**Handoff** moves files, photos, videos, and text between your phone, tablet, and computer simply by scanning a QR code. No app installs, no account creation, and no passwords required.

Open [handoffdrop.app](https://handoffdrop.app) on your computer, scan the QR code with your phone camera, and your devices are instantly paired.

---

## ✨ Features

- 📱 **Cross-Platform by Design:** Transfer seamlessly between **iPhone ↔ Windows PC**, **Android ↔ Mac**, **Mac ↔ PC**, or phone-to-phone.
- ⚡ **Zero Setup & No Apps:** Runs entirely in modern web browsers (Chrome, Safari, Firefox, Edge, Brave, Arc).
- 🔒 **Client-Side End-to-End Encryption (E2EE):** Text and files of any size are encrypted with 256-bit AES-GCM before leaving your device. Keys never touch the server.
- 📦 **Large File Support (Up to 1.5 GB):** Encrypted in 8 MB chunks and streamed through Cloudflare R2, so memory stays flat even on iPhones.
- ⏳ **Strictly Ephemeral:** Uploaded files auto-delete after 15 minutes (or immediately upon receipt). Text vanishes after 60 seconds.
- 🖼️ **On-the-Fly HEIC Conversion:** Automatically converts Apple HEIC photos to standard JPEG for instant compatibility on Windows and Android.
- 📲 **iOS Shortcut & PWA Share Target:** Send photos and documents straight from the iOS or Android Share Sheet using the included "Handoff to PC" shortcut.
- 🧩 **Chrome Extension:** Right-click any link, image, or selection to [send it to your phone](https://chromewebstore.google.com/detail/jmjapgakklfhafbgheccblmkhnmbmnkd), with Handoff in the side panel.
- 💻 **Computer-to-Computer Bridge:** Use a phone to scan two computers' QR codes and bridge a high-speed file pipeline between both desktops.
- 💸 **100% Free:** No subscriptions, paywalls, or feature limits.

---

## 🔒 Security & Privacy Architecture

Handoff is built with a **zero-knowledge privacy model**:

```
[ Computer ]                                      [ Phone ]
     │                                                │
     ├── 1. Generates 256-bit AES-GCM Key locally     │
     │      (never transmitted to any server)         │
     │                                                │
     ├── 2. Shows QR Code:                            │
     │      handoffdrop.app/?room=XYZ#key=BASE64_KEY  │
     │                                                │
     │                 3. Scans QR                    │
     │ ◄─────────────────────────────────────────────-┤
     │                                                │
     │      4. URL fragment (#key=...) parsed         │
     │         locally by phone browser               │
     │                                                │
[ Encrypted Ciphertext via Supabase Realtime / Cloudflare R2 ]
```

1. **Client-Side Key Generation:** An ephemeral 256-bit AES-GCM cryptographic key is generated locally in the browser using the Web Crypto API (`window.crypto.subtle`).
2. **URL Hash Fragment Isolation:** The encryption key is embedded exclusively into the QR code URL's **hash fragment** (`#key=...`). Under RFC 3986, browsers *never* transmit the hash fragment to HTTP servers or logs.
3. **Zero-Knowledge Relay:** Supabase Realtime channels and Cloudflare R2 only handle encrypted ciphertext for E2EE transfers. The host infrastructure has no ability to decrypt your data.
4. **Automated Lifecycle Purge:** Files staged in Cloudflare R2 are deleted 15 minutes after upload by a scheduled cleanup function (`cleanup-storage`, run by `pg_cron` every 10 minutes), which also aborts abandoned uploads.

**Not end-to-end encrypted:** text and files sent with the iOS Shortcut (Shortcuts can't access the browser's key), and large files sent to a device that can't decrypt them on-device (e.g. older iPhones). These go over HTTPS only, are deleted on the same 15-minute schedule, and are shown without the 🔒 E2EE tag.

### How large files are encrypted

Encrypting a 1.5 GB video in one piece would need the whole file in memory, and iPhone Safari reloads the page long before that. Instead:

- **Chunked AES-GCM.** Files are encrypted in 8 MB chunks, each with its own IV (a per-file random prefix plus the chunk index) and authenticated data binding the chunk's position and whether it's the last one. Chunks can't be reordered, dropped, or truncated without decryption failing.
- **Multipart upload.** Each encrypted chunk is exactly one R2 multipart part, uploaded three at a time with retries, so memory use stays at a few chunks regardless of file size.
- **Streaming decryption to disk.** The receiver decrypts while downloading: straight into the Save dialog on Chrome/Edge desktop, or into the browser's private on-device storage (OPFS) on phones, then hands over a disk-backed file. Verified on an iPhone 17 with 1 GB files.
- **Capability negotiation.** Devices advertise what they support over Supabase Presence, so a sender only uses the chunked format when every connected device can read it.

---

## 📊 Specifications & Limits

| Specification | Limit | Details |
| :--- | :--- | :--- |
| **Price** | Free ($0) | No subscriptions, accounts, or paywalls |
| **Max File Size** | 1.5 GB / file | Enforced by the app |
| **End-to-End Encryption** | Text & files, any size | 256-bit AES-GCM; chunked above 8 MB |
| **File Retention** | 15 minutes | Purged by the scheduled cleanup function |
| **Text Retention** | 60 seconds | Stored in volatile client memory only |
| **Session Lifetime** | 2 hours | Room tokens auto-expire |
| **Concurrent Uploads** | 2 files | Each large file uploads 3 chunks at a time |

---

## 🛠️ Tech Stack & Philosophy

We believe web software should be fast, transparent, and built on web standards:

- **Frontend:** Pure **Vanilla JavaScript (ES Modules)**, zero bundlers, zero framework dependencies, modern CSS with responsive layouts and dark mode.
- **Signaling & Pairing:** **Supabase Realtime Broadcast** over WebSockets, keyed by unguessable room identifiers.
- **File Transfer:** **Cloudflare R2** via presigned S3 URLs minted by Supabase Edge Functions (`r2-sign`).
- **iOS Integration:** Native Apple Shortcut stream ingestion via the `shortcut-upload` Edge Function.
- **Testing:** Node.js native test runner (`node --test`, Node 22+) with zero external test framework dependencies.

---

## 🚀 Running Locally

### Prerequisites
- **Node.js 22.13+** (recommended)

### 1. Clone & Install
```sh
git clone https://github.com/eyar/handoff.git
cd handoff
npm install
```

### 2. Configure Environment
Copy the example client configuration:
```sh
cp public/config.example.js public/config.js
```
Fill in your Supabase Project URL and **publishable** key in `public/config.js` (found in Supabase Dashboard → Project Settings → API).

### 3. Start Development Server
```sh
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

> **💡 Mobile Testing Tip:** To test QR code pairing with a physical phone over the internet, start a quick Cloudflare tunnel:
> ```sh
> npm run tunnel:quick
> ```

---

## 🧪 Testing & Code Quality

Handoff includes a fast, zero-dependency unit and integration test suite:

```sh
# Run syntax and module integrity check
npm run lint

# Run all unit and integration tests
npm test

# Run Chrome browser automated end-to-end flow
node scripts/test-e2e-chrome.js
```

---

## 🌐 Self-Hosting & Deployment

Handoff can be deployed for free using a **Cloudflare Worker with static assets** and a **free-tier Supabase project**:

### 1. Deploy Frontend (Cloudflare Workers)
The site is plain static files in `public/`, served by the Worker configured in `wrangler.toml`.
1. Point `public/config.js` at your Supabase project.
2. Deploy with `npx wrangler deploy`, or connect the repository in **Cloudflare Dashboard** → **Workers & Pages** to deploy on every push.

### 2. Configure Cloudflare R2 & Supabase Functions
Set your R2 storage secrets in Supabase CLI or Dashboard:
```sh
supabase secrets set \
  R2_ACCOUNT_ID="your_cloudflare_account_id" \
  R2_ACCESS_KEY_ID="your_r2_access_key_id" \
  R2_SECRET_ACCESS_KEY="your_r2_secret_access_key" \
  R2_BUCKET_NAME="handoff-files"
```
Apply the database migrations and deploy the Edge Functions (`supabase/config.toml` turns off JWT verification for them, since the app has no accounts):
```sh
supabase db push
supabase functions deploy r2-sign
supabase functions deploy shortcut-upload
supabase functions deploy cleanup-storage
```

### 3. Schedule the cleanup
Files are only deleted when `cleanup-storage` runs. Schedule it every 10 minutes with `pg_cron` and `pg_net` (enable both extensions first):
```sql
select cron.schedule('handoff-cleanup', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://<your-project-ref>.supabase.co/functions/v1/cleanup-storage',
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', '<your-anon-or-publishable-key>'),
    body := '{}'::jsonb
  );
$$);
```

---

## 🤝 Contributing

Contributions, bug reports, and suggestions are warmly welcomed!

1. Fork the repository.
2. Create your feature branch (`git checkout -b feat/my-new-feature`).
3. Verify syntax and tests (`npm run lint && npm test`).
4. Commit your changes (`git commit -m 'feat: add support for XYZ'`).
5. Push to the branch (`git push origin feat/my-new-feature`).
6. Open a Pull Request.

---

## 📄 License & Trademark

This project is open-source and licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE).

Under the AGPLv3, you are free to inspect, audit, modify, and self-host this software, provided that any modified versions made available over a network are also shared under the same license with full source code.

**Trademark & Brand Notice:** The name "Handoff", "handoffdrop.app", domain names, and associated visual branding/logos are proprietary trademarks of the author and may not be used in derivative or competing hosted services without explicit written permission.
