import { isDesktopComputer } from "./dom.js";

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function calculateCrc32(uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < uint8Array.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ uint8Array[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function getDosDateTime(date = new Date()) {
  const year = date.getFullYear();
  const dosYear = year < 1980 ? 0 : Math.min(127, year - 1980);
  const dosDate = (dosYear << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { dosDate, dosTime };
}

export async function createZipBlob(fileEntries) {
  const localHeadersAndData = [];
  const centralDirectoryHeaders = [];
  let currentOffset = 0;
  const utf8Encoder = new TextEncoder();

  // Deduplicate filenames if multiple files share the exact same name
  const seenNames = new Map();
  const dedupedEntries = fileEntries.map((entry) => {
    let name = entry.name;
    if (seenNames.has(name)) {
      const count = seenNames.get(name) + 1;
      seenNames.set(name, count);
      const dotIndex = name.lastIndexOf(".");
      if (dotIndex > 0) {
        name = `${name.slice(0, dotIndex)} (${count})${name.slice(dotIndex)}`;
      } else {
        name = `${name} (${count})`;
      }
    } else {
      seenNames.set(name, 1);
    }
    return { ...entry, name };
  });

  for (const entry of dedupedEntries) {
    let rawBytes;
    if (entry.data instanceof Uint8Array) {
      rawBytes = entry.data;
    } else if (entry.data instanceof ArrayBuffer) {
      rawBytes = new Uint8Array(entry.data);
    } else if (entry.data instanceof Blob) {
      rawBytes = new Uint8Array(await entry.data.arrayBuffer());
    } else {
      rawBytes = new Uint8Array(0);
    }

    const nameBytes = utf8Encoder.encode(entry.name);
    const crc = calculateCrc32(rawBytes);
    const size = rawBytes.length;
    const { dosDate, dosTime } = getDosDateTime(entry.lastModified ? new Date(entry.lastModified) : new Date());

    // Local file header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lView = new DataView(localHeader.buffer);
    lView.setUint32(0, 0x04034b50, true);
    lView.setUint16(4, 20, true);
    lView.setUint16(6, 0x0800, true); // UTF-8 filename flag
    lView.setUint16(8, 0, true);      // stored (no compression)
    lView.setUint16(10, dosTime, true);
    lView.setUint16(12, dosDate, true);
    lView.setUint32(14, crc, true);
    lView.setUint32(18, size, true);
    lView.setUint32(22, size, true);
    lView.setUint16(26, nameBytes.length, true);
    lView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const fileLocalOffset = currentOffset;
    localHeadersAndData.push(localHeader);
    localHeadersAndData.push(rawBytes);
    currentOffset += localHeader.length + rawBytes.length;

    // Central directory header (46 bytes + name length)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cView = new DataView(centralHeader.buffer);
    cView.setUint32(0, 0x02014b50, true);
    cView.setUint16(4, 20, true);
    cView.setUint16(6, 20, true);
    cView.setUint16(8, 0x0800, true);
    cView.setUint16(10, 0, true);
    cView.setUint16(12, dosTime, true);
    cView.setUint16(14, dosDate, true);
    cView.setUint32(16, crc, true);
    cView.setUint32(20, size, true);
    cView.setUint32(24, size, true);
    cView.setUint16(28, nameBytes.length, true);
    cView.setUint16(30, 0, true);
    cView.setUint16(32, 0, true);
    cView.setUint16(34, 0, true);
    cView.setUint16(36, 0, true);
    cView.setUint32(38, 0, true);
    cView.setUint32(42, fileLocalOffset, true);
    centralHeader.set(nameBytes, 46);

    centralDirectoryHeaders.push(centralHeader);
  }

  const centralDirOffset = currentOffset;
  let centralDirSize = 0;
  for (const ch of centralDirectoryHeaders) {
    centralDirSize += ch.length;
  }

  // End of Central Directory record (22 bytes)
  const eocd = new Uint8Array(22);
  const eView = new DataView(eocd.buffer);
  eView.setUint32(0, 0x06054b50, true);
  eView.setUint16(4, 0, true);
  eView.setUint16(6, 0, true);
  eView.setUint16(8, dedupedEntries.length, true);
  eView.setUint16(10, dedupedEntries.length, true);
  eView.setUint32(12, centralDirSize, true);
  eView.setUint32(16, centralDirOffset, true);
  eView.setUint16(20, 0, true);

  return new Blob([...localHeadersAndData, ...centralDirectoryHeaders, eocd], {
    type: "application/zip"
  });
}

export function downloadFilesSequentially(fileObjs, triggerFileDownload) {
  fileObjs.forEach((fileObj, idx) => {
    setTimeout(() => {
      triggerFileDownload(fileObj);
    }, idx * 250);
  });
}

export async function downloadFilesAsZip(fileObjs, btnEl, triggerFileDownload) {
  if (!fileObjs || fileObjs.length === 0) return;

  let originalHtml = "";
  if (btnEl) {
    originalHtml = btnEl.innerHTML;
    btnEl.disabled = true;
    btnEl.textContent = "Zipping…";
  }

  try {
    const entries = [];
    for (const fileObj of fileObjs) {
      let data = fileObj.blob;
      if (!data && fileObj.downloadUrl) {
        try {
          const resp = await fetch(fileObj.downloadUrl);
          data = await resp.blob();
        } catch (e) {
          console.error("Failed to load file blob for zip:", e);
        }
      }
      if (data) {
        entries.push({
          name: fileObj.originalName,
          data,
          lastModified: Date.now()
        });
      }
    }

    if (entries.length === 0) return;

    const zipBlob = await createZipBlob(entries);
    const zipUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = zipUrl;
    const dateStr = new Date().toISOString().slice(0, 10);
    a.download = `handoff-files-${dateStr}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(zipUrl), 30000);
  } catch (err) {
    console.error("Failed to create ZIP:", err);
    if (triggerFileDownload) {
      downloadFilesSequentially(fileObjs, triggerFileDownload);
    }
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = originalHtml;
    }
  }
}
