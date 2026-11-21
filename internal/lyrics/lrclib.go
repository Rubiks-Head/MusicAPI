package lyrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"

	"musicapi/internal/core"
)

var ErrNotFound = errors.New("lyrics not found")

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string) *Client {
	return &Client{baseURL: baseURL, http: &http.Client{Timeout: 10 * time.Second}}
}

func (c *Client) Get(ctx context.Context, artist, track string) (core.Lyrics, error) {
	u := c.baseURL + "/get?" + url.Values{
		"artist_name": {artist},
		"track_name":  {track},
	}.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return core.Lyrics{}, err
	}
	req.Header.Set("User-Agent", "MusicAPI/1.0")

	resp, err := c.http.Do(req)
	if err != nil {
		return core.Lyrics{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return core.Lyrics{}, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return core.Lyrics{}, fmt.Errorf("lrclib: %s", resp.Status)
	}

	var body struct {
		TrackName    string `json:"trackName"`
		ArtistName   string `json:"artistName"`
		AlbumName    string `json:"albumName"`
		PlainLyrics  string `json:"plainLyrics"`
		SyncedLyrics string `json:"syncedLyrics"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return core.Lyrics{}, err
	}
	return core.Lyrics{
		Track:  body.TrackName,
		Artist: body.ArtistName,
		Album:  body.AlbumName,
		Plain:  body.PlainLyrics,
		Synced: body.SyncedLyrics,
		Source: "lrclib",
	}, nil
}
