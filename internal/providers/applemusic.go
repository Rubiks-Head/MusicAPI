package providers

import (
	"context"
	"encoding/base64"
	"encoding/json"
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
	jwtRe    = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
	bundleRe = regexp.MustCompile(`src="(/assets/index~[^"]+\.js)"`)
)

type AppleMusic struct {
	staticToken string
	storefront  string
	apiURL      string
	webURL      string
	http        *http.Client

	mu         sync.Mutex
	token      string
	tokenExp   time.Time
	lastScrape time.Time
}

func NewApple(token, storefront, apiURL, webURL string) *AppleMusic {
	return &AppleMusic{
		staticToken: token,
		storefront:  storefront,
		apiURL:      apiURL,
		webURL:      webURL,
		http:        client(),
	}
}

func (a *AppleMusic) Name() string { return "apple" }
func (a *AppleMusic) Cfgd() bool   { return a.staticToken != "" || a.webURL != "" }

func (a *AppleMusic) tok(ctx context.Context) (string, error) {
	if a.staticToken != "" {
		return a.staticToken, nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && time.Now().Before(a.tokenExp.Add(-time.Minute)) {
		return a.token, nil
	}
	if time.Since(a.lastScrape) < 30*time.Second {
		return "", fmt.Errorf("apple: token refresh in backoff")
	}
	a.lastScrape = time.Now()
	tok, exp, err := a.scrape(ctx)
	if err != nil {
		return "", err
	}
	a.token, a.tokenExp = tok, exp
	return a.token, nil
}

func (a *AppleMusic) clear() {
	a.mu.Lock()
	a.token = ""
	a.mu.Unlock()
}

func (a *AppleMusic) scrape(ctx context.Context) (string, time.Time, error) {
	html, err := a.getTxt(ctx, a.webURL+"/"+a.storefront+"/browse")
	if err != nil {
		return "", time.Time{}, err
	}
	m := bundleRe.FindStringSubmatch(html)
	if m == nil {
		return "", time.Time{}, fmt.Errorf("apple: no js bundle found on %s", a.webURL)
	}
	js, err := a.getTxt(ctx, a.webURL+m[1])
	if err != nil {
		return "", time.Time{}, err
	}
	for _, cand := range jwtRe.FindAllString(js, -1) {
		exp, ok := exp(cand)
		if ok {
			return cand, exp, nil
		}
	}
	return "", time.Time{}, fmt.Errorf("apple: no token in bundle %s", m[1])
}

func (a *AppleMusic) getTxt(ctx context.Context, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("apple token fetch %s: %s", u, resp.Status)
	}
	b, err := io.ReadAll(resp.Body)
	return string(b), err
}

func exp(tok string) (time.Time, bool) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Iss string `json:"iss"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Iss == "" || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

func (a *AppleMusic) get(ctx context.Context, path string, q url.Values, out any) error {
	u := a.apiURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	for attempt := 0; ; attempt++ {
		tok, err := a.tok(ctx)
		if err != nil {
			return err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Origin", a.webURL)
		req.Header.Set("Referer", a.webURL+"/")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
		req.Header.Set("X-Apple-Client-Version", "2634.0.0-future.external")

		resp, err := a.http.Do(req)
		if err != nil {
			return err
		}
		if resp.StatusCode == http.StatusUnauthorized && a.staticToken == "" && attempt == 0 {
			resp.Body.Close()
			a.clear()
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("apple %s: %s", path, resp.Status)
		}
		return json.NewDecoder(resp.Body).Decode(out)
	}
}

func (a *AppleMusic) cat() string {
	return "/catalog/" + url.PathEscape(a.storefront)
}

type appleSongAttrs struct {
	Name       string `json:"name"`
	ArtistName string `json:"artistName"`
	AlbumName  string `json:"albumName"`
	DurationMS int64  `json:"durationInMillis"`
	Artwork    struct {
		URL string `json:"url"`
	} `json:"artwork"`
	URL      string `json:"url"`
	Previews []struct {
		URL string `json:"url"`
	} `json:"previews"`
}

type appleArtistAttrs struct {
	Name       string   `json:"name"`
	GenreNames []string `json:"genreNames"`
	Artwork    struct {
		URL string `json:"url"`
	} `json:"artwork"`
	URL string `json:"url"`
}

func artw(template string) string {
	return strings.NewReplacer("{w}", "512", "{h}", "512", "{f}", "webp").Replace(template)
}

func song(id string, s appleSongAttrs) core.Track {
	t := core.Track{
		ID:         id,
		Source:     "apple",
		Title:      s.Name,
		Artists:    []string{s.ArtistName},
		Album:      s.AlbumName,
		DurationMS: s.DurationMS,
		Artwork:    artw(s.Artwork.URL),
		URL:        s.URL,
	}
	if len(s.Previews) > 0 {
		t.PreviewURL = s.Previews[0].URL
	}
	return t
}

func artist(id string, a appleArtistAttrs) core.Artist {
	return core.Artist{
		ID:      id,
		Source:  "apple",
		Name:    a.Name,
		Genres:  a.GenreNames,
		Artwork: artw(a.Artwork.URL),
		URL:     a.URL,
	}
}

func (a *AppleMusic) Srch(ctx context.Context, query string, limit, offset int) (core.SearchResult, error) {
	var body struct {
		Results map[string]struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		} `json:"results"`
		Resources map[string]map[string]struct {
			Attributes json.RawMessage `json:"attributes"`
		} `json:"resources"`
	}
	err := a.get(ctx, a.cat()+"/search", url.Values{
		"term":              {query},
		"types":             {"songs,artists"},
		"limit":             {strconv.Itoa(limit)},
		"offset":            {strconv.Itoa(offset)},
		"l":                 {"en-US"},
		"platform":          {"web"},
		"format[resources]": {"map"},
		"include[songs]":    {"artists"},
		"omit[resource]":    {"autos"},
	}, &body)
	if err != nil {
		return core.SearchResult{}, err
	}

	res := core.SearchResult{Query: query}
	for _, ref := range body.Results["songs"].Data {
		var attrs appleSongAttrs
		if json.Unmarshal(body.Resources["songs"][ref.ID].Attributes, &attrs) == nil {
			res.Tracks = append(res.Tracks, song(ref.ID, attrs))
		}
	}
	for _, ref := range body.Results["artists"].Data {
		var attrs appleArtistAttrs
		if json.Unmarshal(body.Resources["artists"][ref.ID].Attributes, &attrs) == nil {
			res.Artists = append(res.Artists, artist(ref.ID, attrs))
		}
	}
	return res, nil
}

func (a *AppleMusic) Trk(ctx context.Context, id string) (core.Track, error) {
	var body struct {
		Data []struct {
			ID         string         `json:"id"`
			Attributes appleSongAttrs `json:"attributes"`
		} `json:"data"`
	}
	err := a.get(ctx, a.cat()+"/songs/"+url.PathEscape(id), url.Values{"l": {"en-US"}}, &body)
	if err != nil {
		return core.Track{}, err
	}
	if len(body.Data) == 0 {
		return core.Track{}, fmt.Errorf("apple: track %s not found", id)
	}
	return song(body.Data[0].ID, body.Data[0].Attributes), nil
}

func (a *AppleMusic) Art(ctx context.Context, id string) (core.Artist, error) {
	var body struct {
		Data []struct {
			ID         string           `json:"id"`
			Attributes appleArtistAttrs `json:"attributes"`
		} `json:"data"`
	}
	err := a.get(ctx, a.cat()+"/artists/"+url.PathEscape(id), url.Values{"l": {"en-US"}}, &body)
	if err != nil {
		return core.Artist{}, err
	}
	if len(body.Data) == 0 {
		return core.Artist{}, fmt.Errorf("apple: artist %s not found", id)
	}
	return artist(body.Data[0].ID, body.Data[0].Attributes), nil
}
