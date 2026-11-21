package engine

import (
	"context"
	"encoding/json"
	"sync"

	"musicapi/internal/core"
	"musicapi/internal/lyrics"
	"musicapi/internal/providers"
)

type Error struct {
	Code string `json:"code"`
	Msg  string `json:"message"`
}

func (e *Error) Error() string { return e.Msg }

type Config struct {
	Domains struct {
		SoundCloudAPI string `json:"soundcloud_api"`
		SoundCloudWeb string `json:"soundcloud_web"`
		AppleAPI      string `json:"apple_api"`
		AppleWeb      string `json:"apple_web"`
		YouTubeWeb    string `json:"youtube_web"`
		LRClibAPI     string `json:"lrclib_api"`
		SpotifyWeb    string `json:"spotify_web"`
	} `json:"domains"`
	Apple struct {
		Token      string `json:"token"`
		Storefront string `json:"storefront"`
	} `json:"apple"`
	Spotify struct {
		Paired bool `json:"paired"`
	} `json:"spotify"`
}

type Engine struct {
	reg    *providers.Registry
	lyrics *lyrics.Client
}

func New(raw json.RawMessage) (*Engine, error) {
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	return &Engine{
		reg: providers.NewReg(
			providers.NewSC(cfg.Domains.SoundCloudAPI, cfg.Domains.SoundCloudWeb),
			providers.NewApple(cfg.Apple.Token, cfg.Apple.Storefront, cfg.Domains.AppleAPI, cfg.Domains.AppleWeb),
			providers.NewYT(cfg.Domains.YouTubeWeb),
			providers.NewSpot(cfg.Domains.SpotifyWeb, cfg.Spotify.Paired),
		),
		lyrics: lyrics.New(cfg.Domains.LRClibAPI),
	}, nil
}

type SearchResponse struct {
	core.SearchResult
	Errors map[string]string `json:"errors,omitempty"`
}

func (e *Engine) Srch(ctx context.Context, q, source string, limit, offset int) (SearchResponse, error) {
	targets := e.reg.Cfgd()
	if source != "" {
		p, ok := e.reg.Get(source)
		if !ok {
			return SearchResponse{}, &Error{Code: "unknown_source", Msg: "unknown source; see status for providers"}
		}
		if !p.Cfgd() {
			return SearchResponse{}, &Error{Code: "provider_unconfigured", Msg: "provider '" + p.Name() + "' is missing credentials"}
		}
		targets = []providers.Provider{p}
	}
	if len(targets) == 0 {
		return SearchResponse{}, &Error{Code: "no_providers", Msg: "no music services are configured"}
	}

	type partial struct {
		name string
		res  core.SearchResult
		err  error
	}
	ch := make(chan partial, len(targets))
	var wg sync.WaitGroup
	for _, p := range targets {
		wg.Add(1)
		go func(p providers.Provider) {
			defer wg.Done()
			res, err := p.Srch(ctx, q, limit, offset)
			ch <- partial{p.Name(), res, err}
		}(p)
	}
	wg.Wait()
	close(ch)

	resp := SearchResponse{SearchResult: core.SearchResult{Query: q}}
	for p := range ch {
		if p.err != nil {
			if resp.Errors == nil {
				resp.Errors = map[string]string{}
			}
			resp.Errors[p.name] = p.err.Error()
			continue
		}
		resp.Tracks = append(resp.Tracks, p.res.Tracks...)
		resp.Artists = append(resp.Artists, p.res.Artists...)
	}
	return resp, nil
}

func (e *Engine) prov(source string) (providers.Provider, error) {
	p, ok := e.reg.Get(source)
	if !ok {
		return nil, &Error{Code: "unknown_source", Msg: "unknown source"}
	}
	if !p.Cfgd() {
		return nil, &Error{Code: "provider_unconfigured", Msg: "provider '" + p.Name() + "' is missing credentials"}
	}
	return p, nil
}

func (e *Engine) Trk(ctx context.Context, source, id string) (core.Track, error) {
	p, err := e.prov(source)
	if err != nil {
		return core.Track{}, err
	}
	t, err := p.Trk(ctx, id)
	if err != nil {
		return core.Track{}, &Error{Code: "upstream_error", Msg: err.Error()}
	}
	return t, nil
}

func (e *Engine) Art(ctx context.Context, source, id string) (core.Artist, error) {
	p, err := e.prov(source)
	if err != nil {
		return core.Artist{}, err
	}
	a, err := p.Art(ctx, id)
	if err != nil {
		return core.Artist{}, &Error{Code: "upstream_error", Msg: err.Error()}
	}
	return a, nil
}

func (e *Engine) Lyrics(ctx context.Context, artist, track string) (core.Lyrics, error) {
	l, err := e.lyrics.Get(ctx, artist, track)
	if err == lyrics.ErrNotFound {
		return core.Lyrics{}, &Error{Code: "not_found", Msg: "lyrics not found"}
	}
	if err != nil {
		return core.Lyrics{}, &Error{Code: "upstream_error", Msg: err.Error()}
	}
	return l, nil
}

func (e *Engine) Stat() (map[string]any, error) {
	return map[string]any{
		"providers": e.reg.Stat(),
		"lyrics":    "lrclib",
	}, nil
}

func (e *Engine) Pl(ctx context.Context, source, id string) (core.Playlist, error) {
	p, err := e.prov(source)
	if err != nil {
		return core.Playlist{}, err
	}
	pl, ok := p.(providers.Playlister)
	if !ok {
		return core.Playlist{}, &Error{Code: "unsupported", Msg: "provider '" + source + "' does not support playlists"}
	}
	out, err := pl.Pl(ctx, id)
	if err != nil {
		return core.Playlist{}, &Error{Code: "upstream_error", Msg: err.Error()}
	}
	return out, nil
}

func (e *Engine) Strm(ctx context.Context, source, id string) (map[string]string, error) {
	p, err := e.prov(source)
	if err != nil {
		return nil, err
	}
	st, ok := p.(providers.Streamer)
	if !ok {
		return nil, &Error{Code: "unsupported", Msg: "provider '" + source + "' does not support streaming"}
	}
	u, err := st.Strm(ctx, id)
	if err != nil {
		return nil, &Error{Code: "upstream_error", Msg: err.Error()}
	}
	return map[string]string{"url": u}, nil
}
