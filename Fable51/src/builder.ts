import type OpenAI from "openai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const builderSystemPrompt = `You are an expert front-end developer competing in "Prompt Wars".
The user message you receive is the CONTESTANT'S PROMPT. Treat it as the full set of instructions for the website
you must build – follow its intent, tone, content, style and features as closely as you can. Do not simply paste the
prompt text into the page; interpret it and build the site it describes.

HARD TECHNICAL REQUIREMENTS (these always apply, whatever the prompt says):
1. Output ONE complete, self-contained HTML document: <!DOCTYPE html> ... </html>. All CSS in a <style> tag and any
   JavaScript in inline <script> tags. No external stylesheets, fonts, or scripts. No frameworks, no CDNs.
2. The page is shown inside a fixed-size frame with NO scrolling: it may be shown full-screen at 1920x1080, as one of
   six tiles at about 640x540, or as small as 480x270. It MUST look good and readable at all of these sizes.
   - Use a fluid, responsive layout: use vw/vh/clamp()/% units, CSS grid or flexbox, and container-relative sizing.
   - Everything important must fit ABOVE THE FOLD. Set html, body { height: 100%; margin: 0; overflow: hidden; }.
   - Avoid fixed pixel widths larger than 300px. Use font sizes like clamp(0.8rem, 2.2vw, 2.5rem).
3. Images: only use royalty-free placeholder image services with fully qualified https URLs:
   - https://picsum.photos/seed/<any-word>/<width>/<height>   (random photos)
   - https://loremflickr.com/<width>/<height>/<keyword>         (photos matching a keyword, e.g. dog,park)
   Always set width/height attributes or object-fit: cover so layouts do not jump. Emoji and inline SVG are great too.
4. Never: navigate away, open popups, use forms that submit, use fetch/XMLHttpRequest/WebSocket, access
   cookies/localStorage, reference the filesystem or any relative path such as ../, or use window.top/parent.
5. Content must be family friendly: no profanity, no politics, no violence, no adult content.
6. Include a clear title/hero so the theme is understandable from a single screenshot.
7. Light animations or hover effects are welcome but the page must render its main content immediately (within 1s).

Return ONLY the HTML document. No markdown fences, no explanation before or after.`;

export function extractHtml(text: string): string {
  let html = text.trim();
  const fenced = html.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced) html = fenced[1].trim();
  const start = html.search(/<!doctype html/i);
  if (start > 0) html = html.slice(start);
  else if (start === -1) {
    const htmlStart = html.search(/<html/i);
    if (htmlStart > 0) html = html.slice(htmlStart);
  }
  return html;
}

/** Defensive clean-up so a generated page cannot escape its frame or reach outside its folder. */
export function sanitizeHtml(html: string): string {
  let out = html;
  out = out.replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*["'][^>]*>\s*<\/script>/gi, "");
  out = out.replace(/<link\b[^>]*>/gi, "");
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "");
  out = out.replace(/<(iframe|object|embed|frame|frameset)\b[\s\S]*?<\/\1>/gi, "");
  out = out.replace(/<(iframe|object|embed|frame)\b[^>]*\/?>/gi, "");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/\.\.\//g, "");
  out = out.replace(/\b(window\.)?(top|parent)\.location\b/g, "void");
  out = out.replace(/\bwindow\.open\s*\(/g, "void(");
  out = out.replace(/@import\s+[^;]+;/gi, "");
  out = out.replace(/(src|href)\s*=\s*(["'])(?!https?:\/\/|data:|#|mailto:)([^"']*)\2/gi, '$1=$2#$2');

  if (!/<meta\s+name=["']viewport/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="viewport" content="width=device-width, initial-scale=1">`);
  }
  // Belt and braces: guarantee no scrollbars and no navigation inside the frame.
  const guard = `<style>html,body{overflow:hidden!important;}</style>
<script>document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a');if(a){e.preventDefault();}},true);document.addEventListener('submit',function(e){e.preventDefault();},true);</script>`;
  out = /<\/head>/i.test(out) ? out.replace(/<\/head>/i, `${guard}\n</head>`) : guard + out;
  return out;
}

export function fallbackHtml(playerName: string, reason: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Under construction</title>
<style>html,body{height:100%;margin:0;overflow:hidden;font-family:system-ui,sans-serif;background:#1f2937;color:#f9fafb;display:grid;place-items:center;text-align:center}
h1{font-size:clamp(1.2rem,5vw,4rem);margin:0}p{font-size:clamp(.7rem,2vw,1.4rem);opacity:.7}</style></head>
<body><div><div style="font-size:clamp(2rem,10vw,8rem)">🚧</div><h1>${escapeHtml(playerName)}'s site is under construction</h1><p>${escapeHtml(reason)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export async function buildSite(openai: OpenAI, prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: config.buildModel,
    messages: [
      { role: "system", content: builderSystemPrompt },
      { role: "user", content: prompt }
    ]
  });
  const text = response.choices[0]?.message?.content ?? "";
  const html = extractHtml(text);
  if (!/<html/i.test(html) || !/<\/html>/i.test(html)) {
    throw new Error("Model did not return a complete HTML document");
  }
  return sanitizeHtml(html);
}

export function siteDir(roundId: string, submissionId: string): string {
  const dir = path.join(config.sitesDir, roundId, submissionId);
  if (!dir.startsWith(config.sitesDir)) throw new Error("Invalid site path");
  return dir;
}

export async function writeSite(roundId: string, submissionId: string, html: string): Promise<string> {
  const dir = siteDir(roundId, submissionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "index.html"), html, "utf8");
  return `/sites/${roundId}/${submissionId}/`;
}

export async function deleteRoundSites(roundId: string): Promise<void> {
  await fs.rm(path.join(config.sitesDir, roundId), { recursive: true, force: true });
  await fs.rm(path.join(config.screenshotsDir, roundId), { recursive: true, force: true });
}
