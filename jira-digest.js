#!/usr/bin/env node

/**
 * Jira Mentions Digest
 * Fetches all Jira comments where Luke Barrett is mentioned,
 * generates AI-suggested responses, and sends a Slack DM digest.
 *
 * Run daily via cron at 4:00 PM PST.
 */

const https = require("https");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  jira: {
    baseUrl: "https://authorium.atlassian.net",
    email: "luke.barrett@authorium.com",
    accountId: "712020:6f2c98fb-a88c-4b31-933a-05229cfb5215",
    apiToken: process.env.JIRA_API_TOKEN, // set in .env
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY, // set in .env
    model: "claude-sonnet-4-20250514",
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN, // set in .env
    // Your Slack user ID — used to send yourself a DM
    // Find it in Slack: click your name > Profile > ... > Copy member ID
    userId: process.env.SLACK_USER_ID,
  },
};
// ───────────────────────────────────────────────────────────────────────────

/** Generic HTTPS request wrapper (no external dependencies) */
function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

/** Jira API helper */
function jiraRequest(path, method = "GET", body = null) {
  const auth = Buffer.from(
    `${CONFIG.jira.email}:${CONFIG.jira.apiToken}`
  ).toString("base64");

  const options = {
    hostname: "authorium.atlassian.net",
    path,
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  return request(options, body);
}

/**
 * Fetch all issues where Luke has been mentioned in a comment
 * in the last 24 hours.
 */
async function fetchMentionedIssues() {
  // JQL: recently updated issues where Luke is involved (assignee, reporter, or watcher)
  // Client-side filtering then extracts only comments that actually @mention him
  const jql = encodeURIComponent(
    `updated >= -1d AND (assignee = "${CONFIG.jira.email}" OR reporter = "${CONFIG.jira.email}" OR watcher = "${CONFIG.jira.email}") ORDER BY updated DESC`
  );

  const res = await jiraRequest(
    `/rest/api/3/search/jql?jql=${jql}&fields=summary,status,assignee,reporter,priority,comment,description&maxResults=50`
  );

  if (res.status !== 200) {
    throw new Error(`Jira search failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return res.body.issues || [];
}

/**
 * From a list of issues, extract only the comments that mention Luke's account.
 */
function extractMentionedComments(issues) {
  const mentions = [];

  for (const issue of issues) {
    const comments = issue.fields?.comment?.comments || [];

    for (const comment of comments) {
      const body = comment.body;
      // Check for account mention in ADF (Atlassian Document Format)
      const mentionsLuke = JSON.stringify(body).includes(CONFIG.jira.accountId);
      if (!mentionsLuke) continue;

      // Extract plain text from ADF
      const plainText = extractPlainTextFromAdf(body);

      // Only include comments updated in last 24 hours
      const updatedAt = new Date(comment.updated);
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      if (updatedAt < oneDayAgo) continue;

      mentions.push({
        issueKey: issue.key,
        issueSummary: issue.fields.summary,
        issueUrl: `${CONFIG.jira.baseUrl}/browse/${issue.key}`,
        issueStatus: issue.fields.status?.name || "Unknown",
        issuePriority: issue.fields.priority?.name || "Unknown",
        commentId: comment.id,
        commentAuthor: comment.author?.displayName || "Unknown",
        commentText: plainText,
        commentUpdated: updatedAt.toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
        }),
      });
    }
  }

  return mentions;
}

/** Recursively extract plain text from Atlassian Document Format (ADF) */
function extractPlainTextFromAdf(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text || "";
  if (node.type === "mention") return `@${node.attrs?.text || "someone"}`;
  if (node.type === "hardBreak") return "\n";

  const children = node.content || [];
  return children.map(extractPlainTextFromAdf).join(
    node.type === "paragraph" ? "\n" : ""
  );
}

/** Generate AI-suggested response for a single comment using Anthropic API */
async function generateSuggestedResponse(mention) {
  const prompt = `You are helping Luke Barrett, a Product Manager at Authorium (a govtech procurement software company), draft a response to a Jira comment where he was mentioned.

Issue: ${mention.issueKey} - ${mention.issueSummary}
Status: ${mention.issueStatus} | Priority: ${mention.issuePriority}
Comment from ${mention.commentAuthor}:
"${mention.commentText}"

Write a concise, professional reply that Luke could post in Jira. Keep it under 3 sentences. Be direct and actionable. Don't use filler phrases like "Great question!" or "Thanks for reaching out."`;

  const body = JSON.stringify({
    model: CONFIG.anthropic.model,
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  const options = {
    hostname: "api.anthropic.com",
    path: "/v1/messages",
    method: "POST",
    headers: {
      "x-api-key": CONFIG.anthropic.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const res = await request(options, body);

  if (res.status !== 200) {
    console.error(`Anthropic API error for ${mention.issueKey}:`, res.body);
    return "_Could not generate suggestion._";
  }

  return res.body.content?.[0]?.text || "_No suggestion generated._";
}

/** Send a Slack DM to Luke with the full digest */
async function sendSlackDigest(mentions, suggestedResponses) {
  // First, open a DM channel with Luke
  const dmRes = await request(
    {
      hostname: "slack.com",
      path: "/api/conversations.open",
      method: "POST",
      headers: {
        Authorization: `Bearer ${CONFIG.slack.botToken}`,
        "Content-Type": "application/json",
      },
    },
    { users: CONFIG.slack.userId }
  );

  if (!dmRes.body.ok) {
    throw new Error(`Failed to open Slack DM: ${JSON.stringify(dmRes.body)}`);
  }

  const channelId = dmRes.body.channel.id;

  // Build the message blocks
  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    dateStyle: "full",
  });

  const headerBlocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔔 Jira Mentions Digest",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${now}* · ${mentions.length} mention${mentions.length !== 1 ? "s" : ""} in the last 24 hours`,
        },
      ],
    },
    { type: "divider" },
  ];

  const mentionBlocks = [];

  for (let i = 0; i < mentions.length; i++) {
    const m = mentions[i];
    const suggestion = suggestedResponses[i];

    mentionBlocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*<${m.issueUrl}|${m.issueKey}>* · ${m.issueSummary}\n_${m.issueStatus}_ · Priority: ${m.issuePriority}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${m.commentAuthor}* said _(${m.commentUpdated})_:\n> ${m.commentText.replace(/\n/g, "\n> ")}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `💡 *Suggested reply:*\n${suggestion}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Jira" },
            url: m.issueUrl,
            style: "primary",
          },
        ],
      },
      { type: "divider" }
    );
  }

  const noMentionsBlock = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "✅ No new mentions in Jira in the last 24 hours. You're all caught up!",
      },
    },
  ];

  const blocks = [
    ...headerBlocks,
    ...(mentions.length > 0 ? mentionBlocks : noMentionsBlock),
  ];

  // Slack has a 50-block limit per message; split if needed
  const chunkSize = 48;
  const chunks = [];
  for (let i = 0; i < blocks.length; i += chunkSize) {
    chunks.push(blocks.slice(i, i + chunkSize));
  }

  for (const chunk of chunks) {
    const msgRes = await request(
      {
        hostname: "slack.com",
        path: "/api/chat.postMessage",
        method: "POST",
        headers: {
          Authorization: `Bearer ${CONFIG.slack.botToken}`,
          "Content-Type": "application/json",
        },
      },
      {
        channel: channelId,
        text: `Jira Mentions Digest — ${mentions.length} mention(s)`,
        blocks: chunk,
      }
    );

    if (!msgRes.body.ok) {
      throw new Error(`Slack message failed: ${JSON.stringify(msgRes.body)}`);
    }
  }

  console.log(`✅ Slack digest sent with ${mentions.length} mention(s).`);
}

/** Main entry point */
async function main() {
  console.log("🔍 Fetching Jira mentions...");

  // Validate environment
  const missing = ["JIRA_API_TOKEN", "ANTHROPIC_API_KEY", "SLACK_BOT_TOKEN", "SLACK_USER_ID"]
    .filter((k) => !process.env[k]);

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(", ")}`);
    console.error("   See README.md for setup instructions.");
    process.exit(1);
  }

  try {
    // 1. Fetch issues with mentions
    const issues = await fetchMentionedIssues();
    console.log(`   Found ${issues.length} issues with recent activity.`);

    // 2. Extract specific comments mentioning Luke
    const mentions = extractMentionedComments(issues);
    console.log(`   Found ${mentions.length} comment(s) mentioning you.`);

    // 3. Generate AI suggestions for each
    let suggestedResponses = [];
    if (mentions.length > 0) {
      console.log("🤖 Generating AI suggested responses...");
      suggestedResponses = await Promise.all(
        mentions.map((m) => generateSuggestedResponse(m))
      );
    }

    // 4. Send Slack digest
    console.log("📨 Sending Slack digest...");
    await sendSlackDigest(mentions, suggestedResponses);
  } catch (err) {
    console.error("❌ Error:", err.message);
    process.exit(1);
  }
}

main();
