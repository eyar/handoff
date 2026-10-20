# Handoff end-to-end test (paste everything below into Claude in Chrome)

---

You are running an end-to-end test of the live site **https://handoffdrop.app** in this Chrome window. Work carefully, take a screenshot at each checkpoint, and at the end give me a pass/fail table with one row per step and a short note on anything that failed or looked wrong.

Ground rules:
- **Handoff is 100% free.** Confirm there are no payment buttons, paywalls, or third-party checkout scripts (e.g. Paddle) loaded on the page.
- Only create small test files (a few KB) for real uploads.
- Use two new tabs for the test and leave other tabs alone. If an "undergoing maintenance" alert appears at any point, stop and report it.
- Check the DevTools console of each tab when a step fails and include any red errors in the report.

## 1. Home page

1. Open https://handoffdrop.app in a new tab (call it **Tab A**).
2. Check: the headline "Send text & files without sending them to yourself." is visible, there is a **Start a handoff** button, and the pricing section shows **100% Free & Private (up to 1.5 GB)** with zero paywalls.
3. Check the footer has links for iOS Shortcut, Privacy Policy, Terms & Conditions, Accessibility, a Diagnostics button, and a Guides row with six links.
4. Verify in DevTools that no Paddle script (`paddle.js`) is loaded into the DOM.

## 2. Start a handoff (Tab A)

1. Click **Start a handoff**.
2. Check: a QR code appears, the kicker reads "Ready to pair", the status reads "Waiting for your phone…", and the page shows a file dropzone and a text box ("or share from this computer").
3. Check the address bar is just `https://handoffdrop.app/` with no `?room=` in it (the room id is deliberately hidden).
4. Get the room id by running this JavaScript in Tab A and note the result:
   ```js
   JSON.parse(localStorage.getItem("handoff_computer_session")).roomId
   ```

## 3. Pair a second computer (Tab B)

1. Open a second new tab (**Tab B**) at `https://handoffdrop.app/?room=<ROOM_ID>` using the id from step 2.4.
2. Within about 10 seconds, check in **both** tabs: the title changes to "Connected to computer", the kicker reads "Computer-to-Computer session", the timer pill says "Live session", and the status says "Connected to other computer. Share text or files anytime."
3. Check the send button label (once files are added) reads "Send files to other computer" and the received-files label reads "Files from other computer".

## 4. Live text sync

1. In Tab A, click the text box and type: `Handoff e2e test 123`.
2. Switch to Tab B. Within a few seconds the same text should appear in its text box, with a countdown/expiry badge (text expires after 1 minute).
3. In Tab B, replace the text with a URL: `https://example.com/handoff-test`. Check it appears in Tab A, shown as a clickable link.
4. In Tab A, click **Copy to clipboard**. Check the status says "✓ Copied to clipboard and cleared" (or similar) and that the text clears in **both** tabs shortly after.
5. Type any short text in Tab A and wait just over 60 seconds without touching it. Check it clears on its own in both tabs.

## 5. File transfer (Cloudflare R2 Direct Upload)

1. In Tab A, run this JavaScript to drop two test files on the dropzone:
   ```js
   const dt = new DataTransfer();
   dt.items.add(new File(["hello from handoff e2e\n".repeat(50)], "e2e-note.txt", { type: "text/plain" }));
   dt.items.add(new File([new Uint8Array(20000).fill(65)], "e2e-data.bin", { type: "application/octet-stream" }));
   document.querySelector("#desktop-dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
   ```
2. Check in Tab A: the files are listed, upload starts immediately without any paywalls or payment prompts, a progress bar runs, and finishes successfully.
3. Check in Tab B: a "Files from other computer" section shows both files with a count of 2, each with a size, a countdown badge (about 15 minutes), and a **Download** button.
4. In Tab B, click **Download** on `e2e-note.txt`. Check the download starts and completes.
5. In Tab B, tick the remaining file and use **Delete selected** (the trash button). Check it disappears from both tabs.

## 6. Cancel upload flow

1. In Tab A, stage a file and cancel it via the red cancel button:
   ```js
   const dt = new DataTransfer();
   dt.items.add(new File([new Uint8Array(1024 * 1024).fill(66)], "test-cancel.bin", { type: "application/octet-stream" }));
   document.querySelector("#desktop-dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
   ```
2. Click the cancel button on the staged file. Check the staged file is cleared and no partial upload remains.

## 7. Oversize rejection

1. In Tab A, run:
   ```js
   const huge = new File([new Blob([new Uint8Array(1)])], "e2e-huge.bin");
   Object.defineProperty(huge, "size", { value: 1.6 * 1024 * 1024 * 1024 });
   const dt = new DataTransfer(); dt.items.add(huge);
   document.querySelector("#desktop-dropzone").dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
   ```
2. Check the status says "Files exceed 1.5 GB maximum transfer size." and nothing is staged or uploaded.

## 8. Reload keeps the session

1. Reload Tab A. Check it comes back into the same handoff (not the home page), and within a few seconds both tabs show connected again.

## 9. End the handoff

1. In Tab A, click **End this handoff**.
2. Check: Tab A returns to the home page, and Tab B also returns to the home page with a message like "This handoff has ended."
3. Confirm neither tab still shows the old files or text.

## 10. Guide and legal pages

Open each of these in a tab, one at a time, and check it loads (HTTP 200, no "not found"), has a sensible page title and heading, and has a working link or button back to the app (https://handoffdrop.app/). The Shortcut page and the two XML/text files don't need a back link. Close each tab after checking.

- https://handoffdrop.app/iphone-to-pc
- https://handoffdrop.app/airdrop-for-windows
- https://handoffdrop.app/android-to-mac
- https://handoffdrop.app/iphone-to-android
- https://handoffdrop.app/computer-to-computer
- https://handoffdrop.app/send-to-any-computer
- https://handoffdrop.app/privacy.html
- https://handoffdrop.app/terms.html
- https://handoffdrop.app/refunds.html
- https://handoffdrop.app/accessibility.html
- https://handoffdrop.app/shortcut/
- https://handoffdrop.app/sitemap.xml (check it lists the six guide pages)
- https://handoffdrop.app/robots.txt (check it references the sitemap)

## 11. Diagnostics

1. On the home page, click **Diagnostics** in the footer. Check the button changes to "✓ Copied to clipboard!" and reverts.

## Report

Finish with:
- A table: step number, what was checked, PASS / FAIL / SKIPPED, note.
- Any console errors you saw, with the tab and step they happened in.
- Screenshots of any failures.
