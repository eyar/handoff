import { createClient } from "npm:@supabase/supabase-js@2";
import { S3Client, PutObjectCommand, GetObjectCommand } from "npm:@aws-sdk/client-s3@3.658.1";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.658.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-room-id, x-file-name",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const MAX_FILE_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB limit
const FILE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const PRESIGNED_URL_TTL_SECONDS = 3600; // 1 hour

const MIME_EXTENSIONS: Record<string, string> = {
  "video/quicktime": "mov",
  "video/mp4": "mp4",
  "video/x-m4v": "m4v",
  "video/3gpp": "3gp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/vcard": "vcf",
  "application/octet-stream": "bin",
};

function extensionForMime(mimeType: string): string {
  if (MIME_EXTENSIONS[mimeType]) return MIME_EXTENSIONS[mimeType];
  const subtype = (mimeType.split("/")[1] || "").replace(/^x-/, "").replace(/\+.*$/, "");
  return /^[a-z0-9]{1,5}$/.test(subtype) ? subtype : "bin";
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

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "Server configuration missing" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Check Maintenance / Kill Switch
  try {
    const { data: killSwitch } = await supabase
      .from("kill_switch")
      .select("is_active")
      .limit(1)
      .maybeSingle();

    if (killSwitch?.is_active) {
      return jsonResponse({ error: "Handoff is temporarily paused for maintenance." }, 503);
    }
  } catch (_) {
    // Continue if kill_switch check fails
  }

  const url = new URL(req.url);
  const rawRoomId = (
    req.headers.get("x-room-id") ||
    url.searchParams.get("room") ||
    url.searchParams.get("roomId") ||
    ""
  ).toLowerCase().trim();

  const allowedHosts = ["handoffdrop.app", "tunnel.handoffdrop.app", "localhost:3000"];
  const requestedHost = (req.headers.get("x-app-host") || url.searchParams.get("host") || "").toLowerCase().trim();
  const appHost = allowedHosts.includes(requestedHost) ? requestedHost : "handoffdrop.app";
  const appBaseUrl = appHost.includes("localhost") ? `http://${appHost}` : `https://${appHost}`;

  const isExplicitRoom = /^[a-z0-9]{10}$/.test(rawRoomId);
  const contentType = (req.headers.get("content-type") || "").toLowerCase();

  async function broadcast(event: string, payload: unknown, targetRoom: string) {
    try {
      await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            {
              topic: `handoff:${targetRoom}`,
              event,
              payload,
            },
          ],
        }),
      });
    } catch (err) {
      console.warn("Realtime broadcast warning:", err);
    }
  }

  // 1. JSON payload: Text or Link Sync
  if (contentType.includes("application/json")) {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const targetRoom = (body?.roomId || rawRoomId || "").toLowerCase().trim();
    const hasValidRoom = /^[a-z0-9]{10}$/.test(targetRoom);
    const text = String(body?.text || body?.url || "").trim();

    if (!text) {
      return jsonResponse({ error: "No text or url provided" }, 400);
    }

    if (hasValidRoom) {
      await broadcast(
        "text:sync",
        {
          text,
          senderDevice: "iPhone Shortcut",
          expiresAt: Date.now() + 60000,
        },
        targetRoom
      );

      return jsonResponse({
        success: true,
        type: "text",
        roomId: targetRoom,
        redirectUrl: `${appBaseUrl}/?room=${targetRoom}`,
        message: "Text synced to computer successfully",
      });
    }

    return jsonResponse({
      success: true,
      type: "text",
      redirectUrl: `${appBaseUrl}/?text=${encodeURIComponent(text)}`,
      message: "Opening Handoff with text...",
    });
  }

  // 2. File / Photo Upload (Direct Streaming to Cloudflare R2)
  const s3 = getR2Client();
  if (!s3) {
    console.error("Missing R2 environment variables");
    return jsonResponse({ error: "R2 storage configuration missing on server" }, 500);
  }

  const bucket = getBucketName();
  let fileName = req.headers.get("x-file-name") || "";
  let mimeType = contentType.split(";")[0].trim() || "application/octet-stream";
  const contentLength = Number(req.headers.get("content-length") || 0);

  if (contentLength > MAX_FILE_SIZE) {
    const sizeMb = Math.round(contentLength / (1024 * 1024));
    return jsonResponse({
      success: false,
      error: `File exceeds 1.5 GB maximum transfer limit`,
      redirectUrl: `${appBaseUrl}/?error=oversized&size=${contentLength}`,
      message: `File is ${sizeMb} MB (exceeds 1.5 GB limit).`,
    }, 400);
  }

  if (!fileName) {
    fileName = `shared-file-${Date.now()}.${extensionForMime(mimeType)}`;
  } else if (!/\.[A-Za-z0-9]{1,5}$/.test(fileName)) {
    fileName = `${fileName}.${extensionForMime(mimeType)}`;
  }

  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileId = crypto.randomUUID().slice(0, 10);

  const targetFolder = isExplicitRoom
    ? rawRoomId
    : crypto.randomUUID().replace(/-/g, "").slice(0, 10).toLowerCase();

  const storagePath = `${targetFolder}/${fileId}-${safeFileName}`;

  try {
    // Generate S3 presigned PUT URL and stream req.body into R2
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: storagePath,
      ContentType: mimeType,
    });
    const uploadUrl = await getSignedUrl(s3, putCommand, { expiresIn: 300 });

    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: req.body,
      // @ts-ignore
      duplex: "half",
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text().catch(() => "");
      console.error("R2 upload error:", uploadRes.status, errText);
      return jsonResponse({
        error: `Storage upload failed: ${errText || uploadRes.statusText}`,
        redirectUrl: `${appBaseUrl}/?error=upload_failed`,
      }, 500);
    }

    // Generate S3 presigned GET download URL
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: storagePath,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(fileName)}"`,
    });
    const downloadUrl = await getSignedUrl(s3, getCommand, { expiresIn: PRESIGNED_URL_TTL_SECONDS });

    const fileExpiresAt = Date.now() + FILE_TTL_MS;
    const finalSize = contentLength || 0;

    if (isExplicitRoom) {
      await broadcast(
        "file:ready",
        {
          fileId,
          originalName: fileName,
          mimeType,
          size: finalSize,
          downloadUrl,
          storagePath,
          senderDevice: "iPhone Shortcut",
          expiresAt: fileExpiresAt,
        },
        rawRoomId
      );

      return jsonResponse({
        success: true,
        type: "file",
        roomId: rawRoomId,
        fileId,
        fileName,
        size: finalSize,
        downloadUrl,
        redirectUrl: `${appBaseUrl}/?room=${rawRoomId}&sent=1`,
        message: `✓ Sent "${fileName}" to computer!`,
      });
    }

    const params = new URLSearchParams({
      staged: fileId,
      name: fileName,
      size: String(finalSize),
      type: mimeType,
      fileUrl: downloadUrl,
      path: storagePath,
    });

    return jsonResponse({
      success: true,
      staged: true,
      type: "file",
      fileId,
      fileName,
      mimeType,
      size: finalSize,
      storagePath,
      downloadUrl,
      redirectUrl: `${appBaseUrl}/?${params.toString()}`,
      message: `✓ Uploaded "${fileName}". Opening Handoff...`,
    });
  } catch (err: any) {
    console.error("Shortcut R2 upload error:", err);
    return jsonResponse({
      error: `Storage upload error: ${err?.message || "Internal server error"}`,
      redirectUrl: `${appBaseUrl}/?error=upload_failed`,
    }, 500);
  }
});
