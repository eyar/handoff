import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "npm:@aws-sdk/client-s3@3.658.1";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.658.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_FILE_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
const PRESIGNED_URL_TTL_SECONDS = 3600; // 1 hour
const MAX_PARTS = 10000;
const MAX_PARTS_PER_SIGN = 50;
const R2_REQUEST_TIMEOUT_MS = 25000;

// Like delete/list below, multipart calls are presigned and sent with fetch (some AWS SDK calls hang in the
// edge runtime). S3-compatible APIs can answer 200 with an <Error> body, so that is treated as a failure too.
async function r2Fetch(url: string, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok || /<Error>/.test(text)) {
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1] || `HTTP ${res.status}`;
    throw new Error(`R2 ${code}`);
  }
  return text;
}

function xmlValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1]);
}

// ListParts returns ETags XML-escaped (&quot;abc&quot;); decode before re-encoding them for Complete
function xmlUnescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getR2Client() {
  const accountId = Deno.env.get("R2_ACCOUNT_ID") || "";
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID") || "";
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

function getBucketName() {
  return Deno.env.get("R2_BUCKET_NAME") || "handoff-files";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Only POST requests are supported" }, 405);
  }

  const s3 = getR2Client();
  if (!s3) {
    console.error("Missing R2 environment variables (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
    return jsonResponse({ error: "R2 storage configuration missing on server" }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body?.action || "upload";
  const roomId = String(body?.roomId || "").toLowerCase().trim();

  if (!/^[a-z0-9]{10}$/.test(roomId)) {
    return jsonResponse({ error: "Invalid roomId" }, 400);
  }

  const bucket = getBucketName();

  // Action: Upload URL generation
  if (action === "upload") {
    // Only sent for unencrypted fallback uploads, which the receiver downloads
    // directly and so need a filename in Content-Disposition.
    const rawFileName = body?.fileName ? String(body.fileName).trim() : null;
    const mimeType = String(body?.mimeType || "application/octet-stream").trim();
    const fileSize = Number(body?.fileSize || 0);

    if (fileSize > MAX_FILE_SIZE) {
      return jsonResponse({ error: "File exceeds 1.5 GB maximum transfer size" }, 400);
    }

    const storagePath = objectKeyFor(body?.fileId);

    try {
      // 1. Presigned PUT for direct upload
      const putCommand = new PutObjectCommand({
        Bucket: bucket,
        Key: storagePath,
        ContentType: mimeType,
      });

      const uploadUrl = await getSignedUrl(s3, putCommand, {
        expiresIn: PRESIGNED_URL_TTL_SECONDS,
      });

      // 2. Presigned GET for direct download
      const downloadUrl = await downloadUrlFor(storagePath, rawFileName, mimeType);

      return jsonResponse({
        success: true,
        uploadUrl,
        downloadUrl,
        storagePath,
        expiresIn: PRESIGNED_URL_TTL_SECONDS,
      });
    } catch (err: any) {
      console.error("Failed to generate R2 signed URLs:", err);
      return jsonResponse({ error: "Failed to generate storage upload URL" }, 500);
    }
  }

  // Shared by "upload" and "multipart-create": room-scoped object key and a presigned GET for the receiver.
  // The key never contains the file name, so bucket listings don't reveal what was sent.
  function objectKeyFor(fileIdRaw: unknown) {
    const fileId = String(fileIdRaw || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "");
    return `${roomId}/${fileId}`;
  }

  async function downloadUrlFor(storagePath: string, rawFileName: string | null, mimeType: string) {
    return getSignedUrl(
      s3!,
      new GetObjectCommand({
        Bucket: bucket,
        Key: storagePath,
        ResponseContentDisposition: rawFileName
          ? `attachment; filename="${encodeURIComponent(rawFileName)}"`
          : "attachment",
        ResponseContentType: mimeType,
      }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS }
    );
  }

  // Validates storagePath + uploadId for the multipart actions below
  function existingUpload(): { key: string; uploadId: string } | Response {
    const key = String(body?.storagePath || "");
    const uploadId = String(body?.uploadId || "");
    if (!key.startsWith(`${roomId}/`) || key.includes("..") || key.length > 512) {
      return jsonResponse({ error: "Invalid storagePath" }, 400);
    }
    if (!uploadId || uploadId.length > 1024) {
      return jsonResponse({ error: "Invalid uploadId" }, 400);
    }
    return { key, uploadId };
  }

  // ---------- Multipart uploads (chunked end-to-end encrypted files) ----------

  if (action === "multipart-create") {
    const fileSize = Number(body?.fileSize || 0);
    if (fileSize > MAX_FILE_SIZE + 64 * 1024 * 1024) {
      // allow the per-chunk encryption overhead on top of the 1.5 GB plaintext limit
      return jsonResponse({ error: "File exceeds 1.5 GB maximum transfer size" }, 400);
    }
    // Multipart uploads are always encrypted; the receiver names the file after decrypting.
    const storagePath = objectKeyFor(body?.fileId);
    try {
      const createUrl = await getSignedUrl(
        s3,
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: storagePath, ContentType: "application/octet-stream" }),
        { expiresIn: 300 }
      );
      const xml = await r2Fetch(createUrl, { method: "POST" });
      const uploadId = xmlValues(xml, "UploadId")[0];
      if (!uploadId) throw new Error("R2 did not return an UploadId");
      return jsonResponse({
        success: true,
        uploadId,
        storagePath,
        downloadUrl: await downloadUrlFor(storagePath, null, "application/octet-stream"),
        expiresIn: PRESIGNED_URL_TTL_SECONDS,
      });
    } catch (err: any) {
      console.error("multipart-create failed:", err);
      return jsonResponse({ error: "Failed to start upload" }, 500);
    }
  }

  if (action === "multipart-sign-parts") {
    const upload = existingUpload();
    if (upload instanceof Response) return upload;
    const partNumbers: number[] = Array.isArray(body?.partNumbers) ? body.partNumbers : [];
    if (
      partNumbers.length === 0 ||
      partNumbers.length > MAX_PARTS_PER_SIGN ||
      !partNumbers.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PARTS)
    ) {
      return jsonResponse({ error: "Invalid partNumbers" }, 400);
    }
    try {
      const urls: Record<number, string> = {};
      for (const partNumber of partNumbers) {
        urls[partNumber] = await getSignedUrl(
          s3,
          new UploadPartCommand({ Bucket: bucket, Key: upload.key, UploadId: upload.uploadId, PartNumber: partNumber }),
          { expiresIn: PRESIGNED_URL_TTL_SECONDS }
        );
      }
      return jsonResponse({ success: true, urls });
    } catch (err: any) {
      console.error("multipart-sign-parts failed:", err);
      return jsonResponse({ error: "Failed to sign upload parts" }, 500);
    }
  }

  if (action === "multipart-complete") {
    const upload = existingUpload();
    if (upload instanceof Response) return upload;
    const expectedParts = Number(body?.partCount || 0);
    try {
      // Read the uploaded parts' ETags from R2 itself (no need for the browser to see ETag headers)
      const parts: { n: number; etag: string }[] = [];
      let marker: string | undefined;
      do {
        const listUrl = await getSignedUrl(
          s3,
          new ListPartsCommand({ Bucket: bucket, Key: upload.key, UploadId: upload.uploadId, PartNumberMarker: marker }),
          { expiresIn: 300 }
        );
        const xml = await r2Fetch(listUrl);
        for (const part of xmlValues(xml, "Part")) {
          parts.push({ n: Number(xmlValues(part, "PartNumber")[0]), etag: xmlUnescape(xmlValues(part, "ETag")[0] || "") });
        }
        marker = xmlValues(xml, "IsTruncated")[0] === "true" ? xmlValues(xml, "NextPartNumberMarker")[0] : undefined;
      } while (marker);

      parts.sort((a, b) => a.n - b.n);
      if (!expectedParts || parts.length !== expectedParts || parts.some((p, i) => p.n !== i + 1)) {
        return jsonResponse({ error: `Upload incomplete: ${parts.length} of ${expectedParts} parts received` }, 409);
      }

      const completeXml =
        "<CompleteMultipartUpload>" +
        parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`).join("") +
        "</CompleteMultipartUpload>";
      const completeUrl = await getSignedUrl(
        s3,
        new CompleteMultipartUploadCommand({ Bucket: bucket, Key: upload.key, UploadId: upload.uploadId }),
        { expiresIn: 300 }
      );
      await r2Fetch(completeUrl, { method: "POST", headers: { "Content-Type": "application/xml" }, body: completeXml });
      return jsonResponse({ success: true, storagePath: upload.key });
    } catch (err: any) {
      console.error("multipart-complete failed:", err);
      return jsonResponse({ error: "Failed to finish upload" }, 500);
    }
  }

  if (action === "multipart-abort") {
    const upload = existingUpload();
    if (upload instanceof Response) return upload;
    try {
      const abortUrl = await getSignedUrl(
        s3,
        new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.key, UploadId: upload.uploadId }),
        { expiresIn: 300 }
      );
      await r2Fetch(abortUrl, { method: "DELETE" }).catch(() => {}); // best effort; R2 also expires stale uploads
      return jsonResponse({ success: true });
    } catch (err: any) {
      console.error("multipart-abort failed:", err);
      return jsonResponse({ error: "Failed to cancel upload" }, 500);
    }
  }

  const deleteKey = async (key: string) => {
    const deleteCommand = new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    });
    const deleteUrl = await getSignedUrl(s3, deleteCommand, {
      expiresIn: 60,
    });
    const res = await fetch(deleteUrl, { method: "DELETE" });
    return res.ok;
  };

  // Action: Delete specific objects from R2
  if (action === "delete") {
    const paths: string[] = Array.isArray(body?.paths)
      ? body.paths.map((p: unknown) => String(p || "").trim())
      : [];

    if (paths.length === 0) {
      return jsonResponse({ success: true, count: 0 });
    }

    // Security guardrail: room can only delete its own files
    const validPaths = paths.filter((p) => p.startsWith(`${roomId}/`));
    if (validPaths.length === 0) {
      return jsonResponse({ success: true, count: 0 });
    }

    try {
      await Promise.all(validPaths.map(deleteKey));
      return jsonResponse({ success: true, count: validPaths.length });
    } catch (err: any) {
      console.error("Failed to delete objects from R2:", err);
      return jsonResponse({ error: "Failed to delete storage objects" }, 500);
    }
  }

  // Action: Delete all objects belonging to a room (e.g. when handoff ends)
  if (action === "delete-room") {
    try {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${roomId}/`,
      });
      const listUrl = await getSignedUrl(s3, listCommand, { expiresIn: 60 });
      const listRes = await fetch(listUrl);
      const xml = await listRes.text();
      const keys: string[] = [];
      const regex = /<Key>([^<]+)<\/Key>/g;
      let match;
      while ((match = regex.exec(xml)) !== null) {
        keys.push(match[1]);
      }

      if (keys.length > 0) {
        await Promise.all(keys.map(deleteKey));
      }
      return jsonResponse({ success: true, count: keys.length });
    } catch (err: any) {
      console.error("Failed to delete room from R2:", err);
      return jsonResponse({ error: "Failed to delete room storage" }, 500);
    }
  }

  return jsonResponse({ error: `Unsupported action: ${action}` }, 400);
});
