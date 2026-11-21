package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"musicapi/internal/core"
)

var (
	scScriptRe   = regexp.MustCompile(`<script crossorigin src="([^"]+)"`)
	scClientIDRe = regexp.MustCompile(`client_id[:=]\s*["']([0-9a-zA-Z]{32})["']`)
)

type SoundCloud struct {
	apiURL string
	webURL string
	http   *http.Client

	mu       sync.Mutex
	clientID string
	scraped  time.Time
}

func NewSC(apiURL, webURL string) *SoundCloud {
	return &SoundCloud{apiURL: apiURL, webURL: webURL, http: client()}
}

func (s *SoundCloud) Name() string { return "soundcloud" }
func (s *SoundCloud) Cfgd() bool   { return s.apiURL != "" && s.webURL != "" }

func (s *SoundCloud) get(ctx context.Context, u string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("soundcloud: %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (s *SoundCloud) cid(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.clientID != "" && time.Since(s.scraped) < 24*time.Hour {
		return s.clientID, nil
	}
	req, err := http.NewRequestWithContext(ctx, "GET", s.webURL+"/", nil)
	if err != nil {
		return "", err
	}
	resp, err := s.http.Do(req)
	if err != nil {
		return "", err
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		return "", err
	}
	scripts := scScriptRe.FindAllSubmatch(body, -1)
	for i := len(scripts) - 1; i >= 0; i-- {
		src := string(scripts[i][1])
		if strings.HasPrefix(src, "/") {
			src = s.webURL + src
		}
		sreq, err := http.NewRequestWithContext(ctx, "GET", src, nil)
		if err != nil {
			continue
		}
		sresp, err := s.http.Do(sreq)
		if err != nil {
			continue
		}
		js, err := io.ReadAll(sresp.Body)
		sresp.Body.Close()
		if err != nil {
			continue
		}
		if m := scClientIDRe.FindSubmatch(js); m != nil {
			s.clientID, s.scraped = string(m[1]), time.Now()
			return s.clientID, nil
		}
	}
	return "", errors.New("soundcloud: no client_id found")
}

type scUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar_url"`
	URL      string `json:"permalink_url"`
}

type scTrack struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	Duration   int64  `json:"duration"`
	FullDur    int64  `json:"full_duration"`
	Artwork    string `json:"artwork_url"`
	URL        string `json:"permalink_url"`
	Streamable bool   `json:"streamable"`
	Auth       string `json:"track_authorization"`
	User       scUser `json:"user"`
	Media      struct {
		Transcodings []struct {
			URL     string `json:"url"`
			Preset  string `json:"preset"`
			Snipped bool   `json:"snipped"`
			Format  struct {
				Protocol string `json:"protocol"`
				Mime     string `json:"mime_type"`
			} `json:"format"`
		} `json:"transcodings"`
	} `json:"media"`
	Publisher struct {
		AlbumTitle string `json:"album_title"`
	} `json:"publisher_metadata"`
}

func sctrk(t scTrack) core.Track {
	dur := t.FullDur
	if dur == 0 {
		dur = t.Duration
	}
	art := t.Artwork
	if art != "" {
		art = strings.Replace(art, "-large", "-t500x500", 1)
	}
	return core.Track{
		ID:         strconv.FormatInt(t.ID, 10),
		Source:     "soundcloud",
		Title:      t.Title,
		Artists:    []string{t.User.Username},
		Album:      t.Publisher.AlbumTitle,
		DurationMS: dur,
		Artwork:    art,
		URL:        t.URL,
	}
}

func (s *SoundCloud) api(ctx context.Context, path string, q url.Values, out any) error {
	cid, err := s.cid(ctx)
	if err != nil {
		return err
	}
	q.Set("client_id", cid)
	return s.get(ctx, s.apiURL+path+"?"+q.Encode(), out)
}

func (s *SoundCloud) Srch(ctx context.Context, query string, limit, offset int) (core.SearchResult, error) {
	res := core.SearchResult{Query: query}
	var body struct {
		Collection []json.RawMessage `json:"collection"`
	}
	if err := s.api(ctx, "/search", url.Values{"q": {query}, "limit": {strconv.Itoa(limit)}, "offset": {strconv.Itoa(offset)}}, &body); err != nil {
		return res, err
	}
	for _, raw := range body.Collection {
		var kind struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(raw, &kind) != nil {
			continue
		}
		switch kind.Kind {
		case "track":
			var t scTrack
			if json.Unmarshal(raw, &t) == nil && t.ID != 0 {
				res.Tracks = append(res.Tracks, sctrk(t))
			}
		case "user":
			var u scUser
			if json.Unmarshal(raw, &u) == nil && u.ID != 0 {
				res.Artists = append(res.Artists, core.Artist{
					ID:      strconv.FormatInt(u.ID, 10),
					Source:  "soundcloud",
					Name:    u.Username,
					Artwork: u.Avatar,
					URL:     u.URL,
				})
			}
		}
	}
	return res, nil
}

func (s *SoundCloud) Trk(ctx context.Context, id string) (core.Track, error) {
	var t scTrack
	if err := s.api(ctx, "/tracks/"+id, url.Values{}, &t); err != nil {
		return core.Track{}, err
	}
	if t.ID == 0 {
		return core.Track{}, errors.New("soundcloud: track not found")
	}
	return sctrk(t), nil
}

func (s *SoundCloud) Art(ctx context.Context, id string) (core.Artist, error) {
	var u scUser
	if err := s.api(ctx, "/users/"+id, url.Values{}, &u); err != nil {
		return core.Artist{}, err
	}
	if u.ID == 0 {
		return core.Artist{}, errors.New("soundcloud: artist not found")
	}
	return core.Artist{ID: strconv.FormatInt(u.ID, 10), Source: "soundcloud", Name: u.Username, Artwork: u.Avatar, URL: u.URL}, nil
}

func (s *SoundCloud) Pl(ctx context.Context, id string) (core.Playlist, error) {
	var p struct {
		ID      int64     `json:"id"`
		Title   string    `json:"title"`
		Desc    string    `json:"description"`
		Artwork string    `json:"artwork_url"`
		Tracks  []scTrack `json:"tracks"`
	}
	if err := s.api(ctx, "/playlists/"+id, url.Values{}, &p); err != nil {
		return core.Playlist{}, err
	}
	out := core.Playlist{ID: id, Source: "soundcloud", Name: p.Title, Description: p.Desc, Image: p.Artwork}
	for _, t := range p.Tracks {
		out.Tracks = append(out.Tracks, sctrk(t))
	}
	return out, nil
}

func (s *SoundCloud) Strm(ctx context.Context, id string) (string, error) {
	cid, err := s.cid(ctx)
	if err != nil {
		return "", err
	}
	var t scTrack
	if err := s.api(ctx, "/tracks/"+id, url.Values{}, &t); err != nil {
		return "", err
	}
	if !t.Streamable {
		return "", errors.New("soundcloud: track not streamable")
	}
	var pick string
	for _, tc := range t.Media.Transcodings {
		if tc.Snipped || strings.Contains(tc.URL, "/preview/") {
			continue
		}
		if tc.Format.Protocol == "progressive" {
			pick = tc.URL
			break
		}
		if tc.Format.Protocol == "hls" && tc.Preset == "aac_160k" && pick == "" {
			pick = tc.URL
		} else if tc.Format.Protocol == "hls" && pick == "" {
			pick = tc.URL
		}
	}
	if pick == "" {
		return "", errors.New("soundcloud: no full stream (preview only)")
	}
	q := url.Values{"client_id": {cid}}
	if t.Auth != "" {
		q.Set("track_authorization", t.Auth)
	}
	var out struct {
		URL string `json:"url"`
	}
	if err := s.get(ctx, pick+"?"+q.Encode(), &out); err != nil {
		return "", err
	}
	if out.URL == "" {
		return "", errors.New("soundcloud: empty stream url")
	}
	return out.URL, nil
}
