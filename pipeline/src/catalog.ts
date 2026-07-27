/**
 * Builds the video catalogue for the Haramain Recordings channel.
 *
 * Two sources, deliberately:
 *   - **YouTube Data API v3** when `YOUTUBE_API_KEY` is set. Walks the uploads
 *     playlist for the full history. Costs 1 quota unit per 50 videos against a
 *     10,000/day free allowance, so a full backfill of a decade of daily
 *     uploads runs at roughly 1% of one day's quota.
 *   - **The channel RSS feed** otherwise. No key, no quota, but only the 15 most
 *     recent uploads. Enough to develop and test the whole pipeline before you
 *     have a key.
 */

import { parseTitle, reconcileDateWithUpload } from "./titleParser.js";
import { MIN_TITLE_CONFIDENCE, type Catalog, type CatalogEntry } from "./types.js";

export const CHANNEL_ID = "UC37tvO47bp_cKH1f4_VQCOA";
/** YouTube's uploads playlist is the channel id with the `UC` prefix swapped for `UU`. */
export const UPLOADS_PLAYLIST_ID = "UU37tvO47bp_cKH1f4_VQCOA";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;

/** `PT1H2M3S` -> 3723. Returns null for unparseable input. */
export function parseIsoDuration(iso: string): number | null {
  const m = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total =
    (d ? Number(d) * 86400 : 0) +
    (h ? Number(h) * 3600 : 0) +
    (min ? Number(min) * 60 : 0) +
    (s ? Number(s) : 0);
  return Number.isFinite(total) ? total : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

interface RawVideo {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number | null;
}

/** Parses the channel's Atom feed. Exported so it can be tested against a fixture. */
export function parseRssFeed(xml: string): RawVideo[] {
  const out: RawVideo[] = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const videoId = /<yt:videoId>(.*?)<\/yt:videoId>/.exec(entry)?.[1];
    const title = /<media:title>([\s\S]*?)<\/media:title>/.exec(entry)?.[1];
    const publishedAt = /<published>(.*?)<\/published>/.exec(entry)?.[1];
    if (!videoId || !title || !publishedAt) continue;
    out.push({
      videoId,
      title: decodeXmlEntities(title).trim(),
      publishedAt,
      durationSeconds: null,
    });
  }
  return out;
}

async function fetchViaRss(): Promise<RawVideo[]> {
  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  return parseRssFeed(await res.text());
}

interface PlaylistItemsResponse {
  nextPageToken?: string;
  items: {
    snippet: { title: string; publishedAt: string; resourceId: { videoId: string } };
  }[];
}

interface VideosResponse {
  items: { id: string; contentDetails: { duration: string } }[];
}

async function fetchViaApi(
  apiKey: string,
  maxVideos: number,
  log: (m: string) => void,
): Promise<RawVideo[]> {
  const videos: RawVideo[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${YOUTUBE_API}/playlistItems`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("playlistId", UPLOADS_PLAYLIST_ID);
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`playlistItems ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as PlaylistItemsResponse;
    for (const item of data.items) {
      videos.push({
        videoId: item.snippet.resourceId.videoId,
        title: item.snippet.title.trim(),
        publishedAt: item.snippet.publishedAt,
        durationSeconds: null,
      });
    }
    pageToken = data.nextPageToken;
    log(`  ${videos.length} videos…`);
  } while (pageToken && videos.length < maxVideos);

  // Durations come from a second endpoint, 50 ids per call.
  const byId = new Map(videos.map((v) => [v.videoId, v]));
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50).map((v) => v.videoId);
    const url = new URL(`${YOUTUBE_API}/videos`);
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);
    const res = await fetch(url);
    if (!res.ok) continue; // durations are nice-to-have, not load-bearing
    const data = (await res.json()) as VideosResponse;
    for (const item of data.items) {
      const v = byId.get(item.id);
      if (v) v.durationSeconds = parseIsoDuration(item.contentDetails.duration);
    }
  }

  return videos;
}

export interface CatalogResult {
  catalog: Catalog;
  /** Entries whose titles the parser could not confidently read. */
  unparsed: CatalogEntry[];
  source: "api" | "rss";
}

export async function buildCatalog(
  options: { apiKey?: string; maxVideos?: number; log?: (m: string) => void } = {},
): Promise<CatalogResult> {
  const log = options.log ?? console.log;
  const maxVideos = options.maxVideos ?? 100_000;

  let raw: RawVideo[];
  let source: "api" | "rss";
  if (options.apiKey) {
    log("fetching uploads playlist via YouTube Data API…");
    raw = await fetchViaApi(options.apiKey, maxVideos, log);
    source = "api";
  } else {
    log("no YOUTUBE_API_KEY set — falling back to the RSS feed (15 most recent)");
    raw = await fetchViaRss();
    source = "rss";
  }

  const entries: CatalogEntry[] = raw.map((v) => {
    const parsed = parseTitle(v.title);
    // The title is the only source of the date, and it is hand-typed. Check it
    // against the upload timestamp before trusting it.
    const { date, corrected } = reconcileDateWithUpload(parsed.date, v.publishedAt);
    return {
      videoId: v.videoId,
      title: v.title,
      publishedAt: v.publishedAt,
      durationSeconds: v.durationSeconds,
      ...parsed,
      date,
      ...(corrected ? { dateCorrected: true } : {}),
    };
  });

  const corrected = entries.filter((e) => e.dateCorrected);
  if (corrected.length > 0) {
    log(`${corrected.length} title date(s) were ahead of the upload and overridden:`);
    for (const e of corrected.slice(0, 10)) {
      log(`  ${e.publishedAt.slice(0, 10)} <- ${e.title}`);
    }
  }

  entries.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

  return {
    catalog: {
      channelId: CHANNEL_ID,
      generatedAt: new Date().toISOString(),
      count: entries.length,
      entries,
    },
    unparsed: entries.filter((e) => e.confidence < MIN_TITLE_CONFIDENCE || e.leftovers.length > 0),
    source,
  };
}
