import { createClient } from "npm:@supabase/supabase-js@2";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} from "npm:@aws-sdk/client-s3@3.658.1";
import { getSignedUrl } from "npm:@aws-sdk/s3-request-presigner@3.658.1";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

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

// Unfinished multipart uploads don't show up as files, so they're aborted separately. A 1.5 GB upload on a
// slow connection can legitimately take a few hours; anything older was abandoned.
const ABANDONED_UPLOAD_MS = 6 * 60 * 60 * 1000;

function xmlValue(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
}

function xmlUnescape(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: "Missing Supabase service environment variables." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Clean up expired files from Cloudflare R2 (> 15 minutes old)
    let deletedR2Count = 0;
    let abortedUploadsCount = 0;
    let r2Error: string | null = null;
    const r2 = getR2Client();
    const bucket = getBucketName();

    if (r2) {
      try {
        // Listings come 1,000 objects at a time; read every page so nothing escapes expiry
        const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
        const items: { key: string; lastModified: number }[] = [];
        let listedOk = false;
        let continuationToken: string | undefined;
        do {
          const listCommand = new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken });
          const listUrl = await getSignedUrl(r2, listCommand, { expiresIn: 60 });
          const listRes = await fetch(listUrl);
          if (!listRes.ok) break;
          listedOk = true;
          const xml = await listRes.text();
          const regex = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<\/Contents>/g;
          let match;
          while ((match = regex.exec(xml)) !== null) {
            items.push({
              key: xmlUnescape(match[1]),
              lastModified: new Date(match[2]).getTime(),
            });
          }
          const nextToken = xmlValue(xml, "IsTruncated") === "true" ? xmlValue(xml, "NextContinuationToken") : undefined;
          continuationToken = nextToken ? xmlUnescape(nextToken) : undefined;
        } while (continuationToken);
        if (listedOk) {

          const expired = items.filter((item) => item.lastModified < fifteenMinutesAgo);
          if (expired.length > 0) {
            await Promise.all(
              expired.map(async (item) => {
                const delCommand = new DeleteObjectCommand({
                  Bucket: bucket,
                  Key: item.key,
                });
                const delUrl = await getSignedUrl(r2, delCommand, { expiresIn: 60 });
                await fetch(delUrl, { method: "DELETE" });
              })
            );
            deletedR2Count = expired.length;
            console.log(`Successfully purged ${deletedR2Count} expired file(s) from Cloudflare R2.`);
          }
        }

        // Abandoned multipart uploads
        const cutoff = Date.now() - ABANDONED_UPLOAD_MS;
        let keyMarker: string | undefined;
        let uploadIdMarker: string | undefined;
        do {
          const listUrl = await getSignedUrl(
            r2,
            new ListMultipartUploadsCommand({ Bucket: bucket, KeyMarker: keyMarker, UploadIdMarker: uploadIdMarker }),
            { expiresIn: 60 }
          );
          const listRes = await fetch(listUrl);
          if (!listRes.ok) break;
          const xml = await listRes.text();
          const stale = [...xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)]
            .map((m) => ({
              key: xmlUnescape(xmlValue(m[1], "Key") || ""),
              uploadId: xmlUnescape(xmlValue(m[1], "UploadId") || ""),
              initiated: new Date(xmlValue(m[1], "Initiated") || 0).getTime(),
            }))
            .filter((u) => u.key && u.uploadId && u.initiated < cutoff);
          await Promise.all(
            stale.map(async (u) => {
              const abortUrl = await getSignedUrl(
                r2,
                new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.key, UploadId: u.uploadId }),
                { expiresIn: 60 }
              );
              const res = await fetch(abortUrl, { method: "DELETE" });
              if (res.ok) abortedUploadsCount++;
            })
          );
          const truncated = xmlValue(xml, "IsTruncated") === "true";
          keyMarker = truncated ? xmlUnescape(xmlValue(xml, "NextKeyMarker") || "") || undefined : undefined;
          uploadIdMarker = truncated ? xmlUnescape(xmlValue(xml, "NextUploadIdMarker") || "") || undefined : undefined;
        } while (keyMarker);
        if (abortedUploadsCount) console.log(`Aborted ${abortedUploadsCount} abandoned multipart upload(s).`);
      } catch (err: any) {
        console.error("Error during R2 cleanup:", err);
        r2Error = err?.message || "R2 cleanup failed";
      }
    } else {
      console.warn("R2 credentials not set in cleanup-storage environment.");
    }

    // 2. Fetch paths of files older than 15 minutes (legacy Supabase storage bucket cleanup)
    let deletedFilesCount = 0;
    let deletedFiles: string[] = [];
    let storageError: string | null = null;

    try {
      const { data: expiredFiles, error: rpcError } = await supabase.rpc("get_expired_handoff_files");

      if (rpcError) {
        storageError = rpcError.message;
      } else {
        const paths: string[] = (expiredFiles || []).map((row: { name: string }) => row.name);

        if (paths.length > 0) {
          const { error: removeError } = await supabase.storage
            .from("handoff-files")
            .remove(paths);

          if (removeError) {
            storageError = removeError.message;
          } else {
            deletedFilesCount = paths.length;
            deletedFiles = paths;
          }
        }
      }
    } catch (storageCatchErr: any) {
      storageError = storageCatchErr?.message || "Storage cleanup failed";
    }

    // 3. Clean up client_errors records older than 48 hours
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let deletedErrorsCount = 0;
    try {
      const { data: deletedErrorsData, error: errorsDeleteError } = await supabase
        .from("client_errors")
        .delete()
        .lt("created_at", fortyEightHoursAgo)
        .select("id");

      if (!errorsDeleteError) {
        deletedErrorsCount = (deletedErrorsData || []).length;
      }
    } catch (_) {}

    // 4. Clean up usage_events rows older than 90 days
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let deletedUsageCount = 0;
    try {
      const { data: deletedUsageData, error: usageDeleteError } = await supabase
        .from("usage_events")
        .delete()
        .lt("created_at", ninetyDaysAgo)
        .select("id");

      if (!usageDeleteError) {
        deletedUsageCount = (deletedUsageData || []).length;
      }
    } catch (_) {}

    return new Response(
      JSON.stringify({
        success: true,
        r2: {
          deletedCount: deletedR2Count,
          abortedUploads: abortedUploadsCount,
          error: r2Error,
        },
        storage: {
          deletedCount: deletedFilesCount,
          deletedFiles,
          error: storageError,
        },
        clientErrors: {
          deletedCount: deletedErrorsCount,
          cutoff: fortyEightHoursAgo,
        },
        usageEvents: {
          deletedCount: deletedUsageCount,
          cutoff: ninetyDaysAgo,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    console.error("Cleanup error:", err);
    return new Response(
      JSON.stringify({ error: err?.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
