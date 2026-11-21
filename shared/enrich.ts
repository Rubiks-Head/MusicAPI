import { mint } from "./audio.ts";

const enc = encodeURIComponent;

export function img(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return `/v1/img/${Buffer.from(raw).toString("base64url")}`;
}

function sizes(artwork?: string): { banner: string | null; logo: string | null } {
  if (!artwork) return { banner: null, logo: null };
  if (artwork.includes("512x512"))
    return { banner: artwork, logo: artwork.replace("512x512", "140x140") };
  if (artwork.includes("-t500x500"))
    return { banner: artwork, logo: artwork.replace("-t500x500", "-large") };
  return { banner: artwork, logo: artwork };
}

export interface RawTrack {
  id: string;
  source: string;
  title: string;
  artists?: string[];
  album?: string;
  duration_ms?: number;
  artwork_url?: string;
  url?: string;
  preview_url?: string;
}

export function vTrk(t: RawTrack) {
  const art = sizes(t.artwork_url);
  const artist = t.artists?.[0];
  return {
    id: t.id,
    source: t.source,
    name: t.title,
    artists: t.artists ?? [],
    album: t.album || null,
    description: null,
    banner: img(art.banner),
    logo: img(art.logo),
    duration_ms: t.duration_ms ?? null,
    url: t.url || null,
    lyrics_url: artist ? `/v1/lyrics?artist=${enc(artist)}&track=${enc(t.title)}` : null,
    audio_url: `/v1/audio/${mint(t.source, t.id)}/file.mp3`,
    preview_url: t.preview_url || null,
  };
}

export interface RawArtist {
  id: string;
  source: string;
  name: string;
  genres?: string[];
  artwork_url?: string;
  url?: string;
}

export function vArt(a: RawArtist) {
  const art = sizes(a.artwork_url);
  return {
    id: a.id,
    source: a.source,
    name: a.name,
    genres: a.genres ?? [],
    banner: img(art.banner),
    logo: img(art.logo),
    url: a.url || null,
  };
}

export interface RawPlaylist {
  id: string;
  source: string;
  name: string;
  description?: string;
  image_url?: string;
  tracks?: RawTrack[];
}

export function vPl(p: RawPlaylist) {
  const art = sizes(p.image_url);
  return {
    id: p.id,
    source: p.source,
    name: p.name,
    description: p.description || null,
    banner: img(art.banner),
    logo: img(art.logo),
    tracks: (p.tracks ?? []).map(vTrk),
  };
}
