const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface ErrorRecord {
  id?: string;
  created_at?: string;
  event_type: string;
  error_message: string;
  error_details?: Record<string, unknown> | null;
  room_id?: string | null;
  user_agent?: string | null;
}

async function sendDiscordNotification(webhookUrl: string, record: ErrorRecord) {
  const eventType = record.event_type || "unknown_error";
  const errorMessage = record.error_message || "No error message provided";
  const roomId = record.room_id || "None";
  const userAgent = record.user_agent ? record.user_agent.slice(0, 180) : "Unknown";
  const createdAt = record.created_at || new Date().toISOString();

  let detailsFormatted = "";
  if (record.error_details && Object.keys(record.error_details).length > 0) {
    const raw = JSON.stringify(record.error_details, null, 2);
    detailsFormatted = raw.length > 900 ? raw.slice(0, 900) + "..." : raw;
  }

  const fields = [
    { name: "Event Type", value: `\`${eventType}\``, inline: true },
    { name: "Room ID", value: `\`${roomId}\``, inline: true },
    { name: "Timestamp", value: new Date(createdAt).toUTCString(), inline: false },
  ];

  if (detailsFormatted) {
    fields.push({
      name: "Details",
      value: `\`\`\`json\n${detailsFormatted}\n\`\`\``,
      inline: false,
    });
  }

  fields.push({
    name: "User Agent",
    value: `\`${userAgent}\``,
    inline: false,
  });

  const isTest = eventType === "test_notification" || eventType === "test";
  const color = isTest ? 0x22c55e : 0xe11d48; // Green for test, Red/rose for error

  const payload = {
    username: "Handoff Telemetry",
    embeds: [
      {
        title: isTest ? "🔔 Handoff Notification Test" : `🚨 Handoff Error: ${eventType}`,
        description: `**${errorMessage.slice(0, 500)}**`,
        color,
        fields,
        footer: {
          text: "Handoff Telemetry • Auto-purged in 48h",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return { ok: res.ok, status: res.status, statusText: res.statusText };
}

async function sendNtfyNotification(topic: string, record: ErrorRecord, customUrl?: string) {
  const ntfyUrl = customUrl || `https://ntfy.sh/${topic}`;
  const eventType = record.event_type || "unknown_error";
  const errorMessage = record.error_message || "No error message provided";
  const roomId = record.room_id || "None";

  let detailsText = "";
  if (record.error_details && Object.keys(record.error_details).length > 0) {
    detailsText = `\nDetails: ` + JSON.stringify(record.error_details).slice(0, 400);
  }

  const isTest = eventType === "test_notification" || eventType === "test";
  const title = isTest ? "Handoff Notification Test" : `Handoff Alert: ${eventType}`;
  const priority = isTest ? "default" : "high";
  const tags = isTest ? "bell,white_check_mark" : "warning,rotating_light";

  const body = `Error: ${errorMessage}\nRoom: ${roomId}${detailsText}`;

  const res = await fetch(ntfyUrl, {
    method: "POST",
    headers: {
      "Title": title,
      "Priority": priority,
      "Tags": tags,
    },
    body,
  });

  return { ok: res.ok, status: res.status, statusText: res.statusText };
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Handle Supabase Database Webhook or direct payload
  let record: ErrorRecord | null = null;
  if (body?.record && typeof body.record === "object") {
    record = body.record;
  } else if (body?.event_type) {
    record = body;
  } else if (body?.test === true) {
    record = {
      event_type: "test_notification",
      error_message: "This is a test notification from Handoff telemetry!",
      error_details: { status: "healthy", testTimestamp: new Date().toISOString() },
      room_id: "test-room",
      user_agent: "Handoff/NotificationTester",
    };
  }

  if (!record || !record.event_type) {
    return new Response(JSON.stringify({ error: "Missing record or event_type in payload" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Read environment secrets
  const discordWebhook = Deno.env.get("DISCORD_WEBHOOK_URL")?.trim();
  const ntfyTopic = Deno.env.get("NTFY_TOPIC")?.trim();
  const ntfyUrl = Deno.env.get("NTFY_URL")?.trim();

  const dispatchResults: Record<string, any> = {};
  const tasks: Promise<void>[] = [];

  // 1. Discord
  if (discordWebhook) {
    tasks.push(
      sendDiscordNotification(discordWebhook, record)
        .then((res) => {
          dispatchResults.discord = { sent: res.ok, status: res.status };
        })
        .catch((err) => {
          dispatchResults.discord = { sent: false, error: err?.message || String(err) };
        })
    );
  } else {
    dispatchResults.discord = { sent: false, skipped: "DISCORD_WEBHOOK_URL not configured" };
  }

  // 2. ntfy.sh
  if (ntfyTopic || ntfyUrl) {
    tasks.push(
      sendNtfyNotification(ntfyTopic || "handoff-alerts", record, ntfyUrl)
        .then((res) => {
          dispatchResults.ntfy = { sent: res.ok, status: res.status };
        })
        .catch((err) => {
          dispatchResults.ntfy = { sent: false, error: err?.message || String(err) };
        })
    );
  } else {
    dispatchResults.ntfy = { sent: false, skipped: "NTFY_TOPIC not configured" };
  }

  await Promise.allSettled(tasks);

  return new Response(
    JSON.stringify({
      success: true,
      eventType: record.event_type,
      dispatched: dispatchResults,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }
  );
});
