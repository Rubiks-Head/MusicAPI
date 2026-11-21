package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"musicapi/internal/core"
)

var spotifyIDRe = regexp.MustCompile(`(?::|/track/)([0-9A-Za-z]{22})`)

type Spotify struct {
	webURL string
	paired bool
	http   *http.Client
}

func NewSpot(webURL string, paired bool) *Spotify {
	return &Spotify{webURL: strings.TrimSuffix(webURL, "/"), paired: paired, http: client()}
}

func (s *Spotify) Name() string { return "spotify" }
func (s *Spotify) Cfgd() bool   { return s.paired }

func tid(ref string) (string, error) {
	if m := spotifyIDRe.FindStringSubmatch(ref); m != nil {
		return m[1], nil
	}
	if spotifyIDRe.MatchString("/track/" + ref) {
		return ref, nil
	}
	return "", errors.New("spotify: expected track id, uri, or url")
}

func (s *Spotify) Srch(_ context.Context, query string, _, _ int) (core.SearchResult, error) {
	return core.SearchResult{Query: query}, errors.New("spotify: search unsupported")
}

func (s *Spotify) Trk(ctx context.Context, ref string) (core.Track, error) {
	id, err := tid(ref)
	if err != nil {
		return core.Track{}, err
	}
	u := s.webURL + "/oembed?url=" + url.QueryEscape(s.webURL+"/track/"+id)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return core.Track{}, err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return core.Track{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return core.Track{}, fmt.Errorf("spotify: oembed %d", resp.StatusCode)
	}
	var o struct {
		Title     string `json:"title"`
		Thumbnail string `json:"thumbnail_url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&o); err != nil {
		return core.Track{}, err
	}
	return core.Track{
		ID:      id,
		Source:  "spotify",
		Title:   o.Title,
		Artists: []string{},
		Artwork: o.Thumbnail,
		URL:     s.webURL + "/track/" + id,
	}, nil
}

func (s *Spotify) Art(context.Context, string) (core.Artist, error) {
	return core.Artist{}, errors.New("spotify: artist lookup unsupported")
}
